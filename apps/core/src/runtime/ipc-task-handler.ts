import { logger } from '../core/logger.js';
import { IpcDeps } from './ipc-domain-types.js';
import { adminTaskHandlers } from './ipc-task-admin-handlers.js';
import { schedulerCreateTaskHandlers } from './ipc-task-scheduler-create-handlers.js';
import { schedulerMutateTaskHandlers } from './ipc-task-scheduler-mutate-handlers.js';
import { schedulerQueryTaskHandlers } from './ipc-task-scheduler-query-handlers.js';
import { TaskHandler, TaskIpcData } from './ipc-task-types.js';

const taskHandlers: Record<string, TaskHandler> = {
  ...schedulerCreateTaskHandlers,
  ...schedulerMutateTaskHandlers,
  ...schedulerQueryTaskHandlers,
  ...adminTaskHandlers,
};

export type { TaskIpcData } from './ipc-task-types.js';

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
    logger.warn({ type: data.type }, 'Unknown IPC task type');
    return;
  }

  await handler({
    data,
    sourceGroup,
    isMain,
    deps,
    registeredGroups,
    sourceGroupJids,
  });
}
