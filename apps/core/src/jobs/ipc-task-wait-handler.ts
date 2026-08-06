import type {
  CoreTaskLifecycleBackend,
  CoreTaskOwner,
  CoreTaskLifecycleResult,
} from '../application/core-tools/task-lifecycle.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import {
  isAsyncTaskTerminal,
  type PublicAsyncTaskDto,
} from '../domain/ports/async-tasks.js';
import type { AsyncCommandTaskService } from './async-command-task-service.js';
import {
  createTaskResponder,
  respondTaskLifecycleResult,
  toTrimmedString,
} from './ipc-shared.js';
import type { TaskContext, TaskHandler } from './ipc-types.js';

type TaskWaitScope = CoreTaskOwner & { sandboxPolicy: unknown };

const publishedTerminalTasks = new WeakMap<
  AsyncCommandTaskService,
  Set<string>
>();

function waitedTasks(result: CoreTaskLifecycleResult): PublicAsyncTaskDto[] {
  if (!result.ok || !result.data || typeof result.data !== 'object') return [];
  const tasks = (result.data as { tasks?: unknown }).tasks;
  return Array.isArray(tasks) ? (tasks as PublicAsyncTaskDto[]) : [];
}

async function publishTerminalTaskEvents(input: {
  context: TaskContext;
  scope: CoreTaskOwner;
  service: AsyncCommandTaskService;
  result: CoreTaskLifecycleResult;
}): Promise<void> {
  const publish = input.context.deps.publishRuntimeEvent;
  if (!publish) return;
  const seen = publishedTerminalTasks.get(input.service) ?? new Set<string>();
  publishedTerminalTasks.set(input.service, seen);
  for (const task of waitedTasks(input.result)) {
    if (
      task.kind !== 'delegated_agent' ||
      !task.taskKey ||
      !isAsyncTaskTerminal(task.status)
    ) {
      continue;
    }
    const terminalKey = `${task.id}:${task.status}`;
    if (seen.has(terminalKey)) continue;
    seen.add(terminalKey);
    try {
      await publish({
        appId: input.scope.appId as never,
        agentId: input.scope.agentId as never,
        conversationId: input.scope.conversationId as never,
        ...(input.scope.threadId
          ? { threadId: input.scope.threadId as never }
          : {}),
        ...(input.context.data.runId
          ? { runId: input.context.data.runId as never }
          : {}),
        ...(input.context.data.jobId
          ? { jobId: input.context.data.jobId as never }
          : {}),
        eventType: RUNTIME_EVENT_TYPES.TASK_UPDATED,
        actor: 'gantry-async-task-runtime',
        correlationId: `async-task-terminal:${terminalKey}`,
        responseMode: 'none',
        payload: {
          taskId: task.id,
          taskKey: task.taskKey,
          status: task.status,
        },
      });
    } catch (error) {
      seen.delete(terminalKey);
      throw error;
    }
  }
}

export function createTaskWaitHandler(input: {
  responder: (context: TaskContext) => ReturnType<typeof createTaskResponder>;
  taskScope: (context: TaskContext) => TaskWaitScope | null;
  taskService: (context: TaskContext) => AsyncCommandTaskService | null;
  validateParentTaskScope: (
    context: TaskContext,
    scope: CoreTaskOwner,
  ) => Promise<
    { ok: true; parentTaskId: string | null } | { ok: false; message: string }
  >;
  taskBackend: (
    context: TaskContext,
    service: AsyncCommandTaskService,
    owner: CoreTaskOwner,
    parent: { parentTaskId: string | null },
  ) => CoreTaskLifecycleBackend;
}): TaskHandler {
  return async (context) => {
    const { reject } = input.responder(context);
    const scope = input.taskScope(context);
    if (!scope) {
      reject(
        'task_wait must target the originating app, agent, and conversation.',
        'forbidden',
      );
      return;
    }
    const service = input.taskService(context);
    if (!service) {
      reject('Async task runtime is unavailable.', 'unavailable');
      return;
    }
    const payload = context.data.payload ?? {};
    const taskIds = Array.isArray(payload.taskIds)
      ? payload.taskIds
          .map((value) => toTrimmedString(value, { maxLen: 160 }))
          .filter((value): value is string => Boolean(value))
      : [];
    const timeoutMs =
      typeof payload.timeoutMs === 'number' ? payload.timeoutMs : undefined;
    const { sandboxPolicy: _sandboxPolicy, ...scopedTaskOwner } = scope;
    const parentTask = await input.validateParentTaskScope(
      context,
      scopedTaskOwner,
    );
    if (!parentTask.ok) {
      reject(parentTask.message, 'forbidden');
      return;
    }
    const result = await input
      .taskBackend(context, service, scopedTaskOwner, parentTask)
      .task_wait({ taskIds, timeoutMs });
    await publishTerminalTaskEvents({
      context,
      scope: scopedTaskOwner,
      service,
      result,
    });
    respondTaskLifecycleResult(context, result);
  };
}
