import { logger } from '../infrastructure/logging/logger.js';
import { IpcDeps } from '../runtime/ipc-domain-types.js';
import { adminTaskHandlers } from './ipc-admin-handlers.js';
import { schedulerCreateTaskHandlers } from './ipc-scheduler-create-handlers.js';
import { schedulerMutateTaskHandlers } from './ipc-scheduler-mutate-handlers.js';
import { schedulerQueryTaskHandlers } from './ipc-scheduler-query-handlers.js';
import { TaskHandler, TaskIpcData } from './ipc-types.js';
import { writeTaskIpcResponse } from './ipc-shared.js';
import { getRuntimeOpsRepository } from '../adapters/storage/postgres/runtime-store.js';

const taskHandlers: Record<string, TaskHandler> = {
  ...schedulerCreateTaskHandlers,
  ...schedulerMutateTaskHandlers,
  ...schedulerQueryTaskHandlers,
  ...adminTaskHandlers,
};

export type { TaskIpcData } from './ipc-types.js';

export async function processTaskIpc(
  data: TaskIpcData,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  const sourceGroupJids = Object.entries(registeredGroups)
    .filter(([, group]) => group.folder === sourceGroup)
    .map(([jid]) => jid);

  const handler = taskHandlers[data.type];
  if (!handler) {
    logger.warn({ type: data.type, sourceGroup }, 'Unknown IPC task type');
    writeTaskIpcResponse(
      sourceGroup,
      data.taskId,
      {
        ok: false,
        code: 'unsupported_task_type',
        error: `Unsupported IPC task type: ${data.type}`,
      },
      data.authThreadId,
    );
    return;
  }

  const resolvedDeps = {
    ...deps,
    opsRepository: deps.opsRepository ?? getRuntimeOpsRepository(),
  };

  try {
    await handler({
      data,
      sourceGroup,
      isMain,
      deps: resolvedDeps,
      registeredGroups,
      sourceGroupJids,
    });
  } catch (err) {
    logger.error(
      { err, type: data.type, sourceGroup },
      'Unhandled IPC task handler error',
    );
    writeTaskIpcResponse(
      sourceGroup,
      data.taskId,
      {
        ok: false,
        code: 'internal_error',
        error: err instanceof Error ? err.message : String(err),
      },
      data.authThreadId,
    );
  }
}
