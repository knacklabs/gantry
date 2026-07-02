import { randomUUID } from 'node:crypto';

import type { McpToolProxy } from '../application/mcp/mcp-tool-proxy.js';
import type {
  AsyncTaskCreateInput,
  AsyncTaskRecord,
  AsyncTaskRepository,
} from '../domain/ports/async-tasks.js';
import { sanitizeOutboundLlmText } from '../shared/sensitive-material.js';
import { nowIso } from '../shared/time/datetime.js';
import { serializeMcpToolResult } from '../application/mcp/mcp-tool-output-bounds.js';
import {
  errorMessage,
  isRecord,
  isTimeoutError,
  taskTimestampMs,
  truncate,
  withLocalAdmissionLock,
} from './async-command-task-helpers.js';
import { cancelledReceipt } from './async-command-task-receipts.js';
import { hasAsyncTaskRunningCapacity } from './async-task-running-capacity.js';
import { asyncMcpPrivateCorrelation } from './async-task-execution-payload.js';

const RUNNING_ASYNC_MCP_STATUSES = ['running'] as const;
const MAX_ACTIVE_ASYNC_MCP_PER_APP = 4;
const MAX_ACTIVE_ASYNC_MCP_PER_AGENT = 2;
const ASYNC_MCP_HEARTBEAT_MS = 15_000;
const ASYNC_MCP_TIMEOUT_MS = 15 * 60_000;
const ASYNC_MCP_STALE_AFTER_MS = 60_000;
const activeAsyncMcpControllers = new Map<
  string,
  {
    controller: AbortController;
    appId: string;
    agentId: string;
    countsAgainstCapacity: boolean;
  }
>();
const pendingAsyncMcpExecutions = new Map<
  string,
  {
    repository: AsyncTaskRepository;
    task: AsyncTaskRecord;
    proxy: McpToolProxy;
    appId: string;
    agentId: string;
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }
>();

export async function createAsyncMcpTask(input: {
  repository: AsyncTaskRepository;
  appId: string;
  agentId: string;
  conversationId: string;
  threadId?: string | null;
  parentTaskId?: string | null;
  jobId?: string;
  runId?: string;
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}): Promise<{ ok: true; task: AsyncTaskRecord }> {
  const now = nowIso();
  const taskId = `task_${randomUUID()}`;
  const createInput: AsyncTaskCreateInput = {
    id: taskId,
    appId: input.appId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    threadId: input.threadId ?? null,
    parentRunId: input.jobId ? null : (input.runId ?? null),
    parentJobId: input.jobId ?? null,
    parentJobRunId: input.jobId ? (input.runId ?? null) : null,
    kind: 'mcp_tool_call',
    status: 'queued',
    admissionClass: 'task',
    authoritySnapshotJson: {
      toolName: 'async_mcp_call',
      mcpToolRule: `mcp__${input.serverName}__${input.toolName}`,
      serverName: input.serverName,
      mcpToolName: input.toolName,
    },
    privateCorrelationJson: asyncMcpPrivateCorrelation({
      appId: input.appId,
      taskId,
      parentTaskId: input.parentTaskId,
      serverName: input.serverName,
      toolName: input.toolName,
      arguments: input.arguments ?? {},
    }),
    leaseToken: randomUUID(),
    fencingVersion: 1,
    summary: `${input.serverName}.${input.toolName}`,
    now,
  };
  await recoverStaleAsyncMcpTasks(input.repository, input.appId);
  return { ok: true, task: await input.repository.createTask(createInput) };
}

async function recoverStaleAsyncMcpTasks(
  repository: AsyncTaskRepository,
  appId: string,
): Promise<void> {
  const staleBefore = Date.now() - ASYNC_MCP_STALE_AFTER_MS;
  const tasks = await repository.listTasks({
    appId,
    statuses: [...RUNNING_ASYNC_MCP_STATUSES],
    limit: 100,
  });
  for (const task of tasks) {
    if (task.kind !== 'mcp_tool_call' || taskTimestampMs(task) > staleBefore) {
      continue;
    }
    const now = nowIso();
    await repository.transitionTask({
      taskId: task.id,
      leaseToken: task.leaseToken,
      fencingVersion: task.fencingVersion,
      status: 'failed',
      now,
      terminalAt: now,
      errorSummary:
        'Async MCP task recovered after its worker stopped heartbeating.',
      receiptJson: {
        completed: 'failed after worker heartbeat expired',
        used: String(
          task.authoritySnapshotJson.mcpToolRule ?? 'async_mcp_call',
        ),
        changed: 'unknown',
        delegated: 'no',
        needsAttention:
          'check the remote MCP system before retrying; work may have already run',
      },
    });
  }
}

export async function enqueueAsyncMcpTask(input: {
  repository: AsyncTaskRepository;
  task: AsyncTaskRecord;
  proxy: McpToolProxy;
  appId: string;
  agentId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<void> {
  pendingAsyncMcpExecutions.set(input.task.id, input);
  await drainAsyncMcpTasks(input.repository);
}

export async function executeAsyncMcpTask(input: {
  repository: AsyncTaskRepository;
  task: AsyncTaskRecord;
  proxy: McpToolProxy;
  appId: string;
  agentId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<void> {
  const controller = new AbortController();
  activeAsyncMcpControllers.set(input.task.id, {
    controller,
    appId: input.appId,
    agentId: input.agentId,
    countsAgainstCapacity: true,
  });
  const toolSummary = `${input.serverName}.${input.toolName}`;
  const running = await input.repository.transitionTask({
    taskId: input.task.id,
    leaseToken: input.task.leaseToken,
    fencingVersion: input.task.fencingVersion,
    status: 'running',
    now: nowIso(),
    heartbeatAt: nowIso(),
    startedAt: nowIso(),
    privateCorrelationJson: taskProgress(input.task, {
      phase: 'running',
      lastProgress: 'MCP tool running.',
      lastToolSummary: toolSummary,
    }),
  });
  if (!running) {
    activeAsyncMcpControllers.delete(input.task.id);
    return;
  }
  const heartbeat = setInterval(() => {
    void input.repository.transitionTask({
      taskId: input.task.id,
      leaseToken: input.task.leaseToken,
      fencingVersion: input.task.fencingVersion,
      status: 'running',
      now: nowIso(),
      heartbeatAt: nowIso(),
      privateCorrelationJson: taskProgress(input.task, {
        phase: 'running',
        lastProgress: 'MCP tool still running.',
        lastToolSummary: toolSummary,
      }),
    });
  }, ASYNC_MCP_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const result = await input.proxy.callTool({
      appId: input.appId as never,
      agentId: input.agentId as never,
      serverName: input.serverName,
      toolName: input.toolName,
      arguments: input.arguments,
      timeoutMs: ASYNC_MCP_TIMEOUT_MS,
      signal: controller.signal,
    });
    const outputSummary = summarizeAsyncMcpResult(result);
    if (controller.signal.aborted) {
      const now = nowIso();
      await input.repository.transitionTask({
        taskId: input.task.id,
        leaseToken: input.task.leaseToken,
        fencingVersion: input.task.fencingVersion,
        status: 'cancelled',
        now,
        terminalAt: now,
        outputSummary: 'MCP tool returned after cancellation; result ignored.',
        privateCorrelationJson: taskProgress(input.task, {
          phase: 'cancelled',
          lastProgress: 'MCP tool returned after cancellation; result ignored.',
          lastToolSummary: toolSummary,
        }),
        receiptJson: cancelledMcpReceipt(input, 'cancelled'),
      });
      return;
    }
    if (isMcpToolErrorResult(result)) {
      const now = nowIso();
      await input.repository.transitionTask({
        taskId: input.task.id,
        leaseToken: input.task.leaseToken,
        fencingVersion: input.task.fencingVersion,
        status: 'failed',
        now,
        terminalAt: now,
        errorSummary: outputSummary,
        privateCorrelationJson: taskProgress(input.task, {
          phase: 'failed',
          lastProgress: outputSummary,
          lastToolSummary: toolSummary,
          blocker: outputSummary,
        }),
        receiptJson: {
          completed: 'failed',
          used: `mcp__${input.serverName}__${input.toolName}`,
          changed: 'unknown',
          delegated: 'no',
          needsAttention: outputSummary,
        },
      });
      return;
    }
    const now = nowIso();
    await input.repository.transitionTask({
      taskId: input.task.id,
      leaseToken: input.task.leaseToken,
      fencingVersion: input.task.fencingVersion,
      status: 'completed',
      now,
      terminalAt: now,
      outputSummary,
      privateCorrelationJson: taskProgress(input.task, {
        phase: 'completed',
        lastProgress: outputSummary,
        lastToolSummary: toolSummary,
      }),
      receiptJson: {
        completed: outputSummary,
        used: `mcp__${input.serverName}__${input.toolName}`,
        changed: 'unknown',
        delegated: 'no',
        needsAttention: 'none',
      },
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    const timedOut = isTimeoutError(err);
    const summary = truncate(
      sanitizeOutboundLlmText(errorMessage(err)).text,
      500,
    );
    const now = nowIso();
    await input.repository.transitionTask({
      taskId: input.task.id,
      leaseToken: input.task.leaseToken,
      fencingVersion: input.task.fencingVersion,
      status: aborted ? 'cancelled' : timedOut ? 'timed_out' : 'failed',
      now,
      terminalAt: now,
      errorSummary: summary,
      privateCorrelationJson: taskProgress(input.task, {
        phase: aborted ? 'cancelled' : timedOut ? 'timed_out' : 'failed',
        lastProgress: summary,
        lastToolSummary: toolSummary,
        ...(aborted ? {} : { blocker: summary }),
      }),
      receiptJson: {
        completed: aborted ? 'cancelled' : timedOut ? 'timed out' : 'failed',
        used: `mcp__${input.serverName}__${input.toolName}`,
        changed: 'unknown',
        delegated: 'no',
        needsAttention: aborted
          ? 'check the remote MCP system before retrying; work may have already run'
          : summary,
      },
    });
  } finally {
    clearInterval(heartbeat);
    activeAsyncMcpControllers.delete(input.task.id);
    void drainAsyncMcpTasks(input.repository);
  }
}

function cancelledMcpReceipt(
  input: {
    serverName: string;
    toolName: string;
  },
  completed: string,
) {
  return {
    completed,
    used: `mcp__${input.serverName}__${input.toolName}`,
    changed: 'unknown',
    delegated: 'no' as const,
    needsAttention:
      'check the remote MCP system before retrying; work may have already run',
  };
}

async function drainAsyncMcpTasks(repository: AsyncTaskRepository) {
  await withLocalAdmissionLock(repository, async () => {
    for (const execution of [...pendingAsyncMcpExecutions.values()]) {
      if (
        !(await hasAsyncTaskRunningCapacity(repository, execution.task, {
          perApp: MAX_ACTIVE_ASYNC_MCP_PER_APP,
          perAgent: MAX_ACTIVE_ASYNC_MCP_PER_AGENT,
        }))
      ) {
        continue;
      }
      const claimed =
        (await repository.claimQueuedTask?.({
          taskId: execution.task.id,
          leaseToken: randomUUID(),
          now: nowIso(),
          maxRunningPerApp: MAX_ACTIVE_ASYNC_MCP_PER_APP,
          maxRunningPerAgent: MAX_ACTIVE_ASYNC_MCP_PER_AGENT,
        })) ?? execution.task;
      if (claimed.status !== 'running' && repository.claimQueuedTask) continue;
      pendingAsyncMcpExecutions.delete(execution.task.id);
      void executeAsyncMcpTask({ ...execution, task: claimed });
    }
  });
}

export async function cancelAsyncMcpTask(
  repository: AsyncTaskRepository,
  task: AsyncTaskRecord,
): Promise<{ ok: boolean; message: string }> {
  const active = activeAsyncMcpControllers.get(task.id);
  const now = nowIso();
  if (active) {
    const cancelled = await repository.transitionTask({
      taskId: task.id,
      leaseToken: task.leaseToken,
      fencingVersion: task.fencingVersion,
      status: 'cancelled',
      now,
      terminalAt: now,
      privateCorrelationJson: taskProgress(task, {
        phase: 'cancelled',
        lastProgress: 'MCP tool cancelled.',
        lastToolSummary: task.summary ?? task.id,
      }),
      receiptJson: cancelledMcpReceipt(
        {
          serverName: String(
            task.authoritySnapshotJson.serverName ?? 'unknown',
          ),
          toolName: String(task.authoritySnapshotJson.mcpToolName ?? 'unknown'),
        },
        'cancelled',
      ),
    });
    if (!cancelled) {
      return {
        ok: false,
        message: 'Task is already finished and cannot be cancelled.',
      };
    }
    active.countsAgainstCapacity = false;
    active.controller.abort();
    return {
      ok: true,
      message:
        'Task was cancelled in Gantry. Remote MCP work may have already run; late results will be ignored.',
    };
  }
  const cancelled = await repository.transitionTask({
    taskId: task.id,
    leaseToken: task.leaseToken,
    fencingVersion: task.fencingVersion,
    status: 'cancelled',
    now,
    terminalAt: now,
    privateCorrelationJson: taskProgress(task, {
      phase: 'cancelled',
      lastProgress: 'MCP tool cancelled.',
      lastToolSummary: task.summary ?? task.id,
    }),
    receiptJson: cancelledReceipt(task),
  });
  pendingAsyncMcpExecutions.delete(task.id);
  const message = cancelled
    ? 'Task was cancelled in Gantry. Remote MCP work may have already run; late results will be ignored.'
    : 'Task is already finished and cannot be cancelled.';
  return { ok: Boolean(cancelled), message };
}

function taskProgress(
  task: AsyncTaskRecord,
  progress: {
    phase: string;
    lastProgress: string;
    lastToolSummary: string;
    blocker?: string;
  },
): Record<string, unknown> {
  return {
    ...(isRecord(task.privateCorrelationJson)
      ? task.privateCorrelationJson
      : {}),
    progress,
  };
}

function summarizeAsyncMcpResult(result: unknown): string {
  const raw = serializeMcpToolResult(result, 1_000).text;
  return truncate(
    sanitizeOutboundLlmText(raw || 'MCP tool completed.').text,
    1_000,
  );
}

function isMcpToolErrorResult(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (result as { isError?: unknown }).isError === true
  );
}
