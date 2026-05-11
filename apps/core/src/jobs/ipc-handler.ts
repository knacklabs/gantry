import { logger } from '../infrastructure/logging/logger.js';
import { IpcDeps } from '../runtime/ipc-domain-types.js';
import { adminTaskHandlers } from './ipc-admin-handlers.js';
import { schedulerCreateTaskHandlers } from './ipc-scheduler-create-handlers.js';
import { schedulerMutateTaskHandlers } from './ipc-scheduler-mutate-handlers.js';
import { schedulerQueryTaskHandlers } from './ipc-scheduler-query-handlers.js';
import { TaskHandler, TaskIpcData } from './ipc-types.js';
import { writeTaskIpcResponse } from './ipc-shared.js';
import {
  getRuntimeControlRepository,
  getRuntimeRepositories,
  getRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import { adaptJobControl } from './ipc-job-control.js';

const taskHandlers: Record<string, TaskHandler> = {
  ...schedulerCreateTaskHandlers,
  ...schedulerMutateTaskHandlers,
  ...schedulerQueryTaskHandlers,
  ...adminTaskHandlers,
};

export type { TaskIpcData } from './ipc-types.js';

export async function processTaskIpc(
  data: TaskIpcData,
  sourceAgentFolder: string,
  deps: IpcDeps,
  ipcBaseDir?: string,
): Promise<void> {
  const conversationBindings = deps.conversationRoutes();
  const sourceAgentFolderJids = Object.entries(conversationBindings)
    .filter(([, group]) => group.folder === sourceAgentFolder)
    .map(([jid]) => jid);

  const handler = taskHandlers[data.type];
  if (!handler) {
    logger.warn(
      { type: data.type, sourceAgentFolder },
      'Unknown IPC task type',
    );
    writeTaskIpcResponse(
      sourceAgentFolder,
      data.taskId,
      {
        ok: false,
        code: 'unsupported_task_type',
        error: `Unsupported IPC task type: ${data.type}`,
      },
      data.authThreadId,
      data.responseKeyId,
    );
    return;
  }

  const resolvedDeps = {
    ...deps,
    opsRepository: deps.opsRepository ?? getRuntimeRepositories(),
    getToolRepository:
      deps.getToolRepository ??
      (() => {
        try {
          return getRuntimeStorage().repositories.tools;
        } catch {
          return undefined;
        }
      }),
    getPermissionRepository:
      deps.getPermissionRepository ??
      (() => {
        try {
          return getRuntimeStorage().repositories.permissions;
        } catch {
          return undefined;
        }
      }),
    getJobControl:
      deps.getJobControl ??
      (() => adaptJobControl(getRuntimeControlRepository())),
  };

  try {
    await handler({
      data,
      sourceAgentFolder,
      ipcBaseDir,
      deps: resolvedDeps,
      conversationBindings,
      sourceAgentFolderJids,
    });
  } catch (err) {
    logger.error(
      { err, type: data.type, sourceAgentFolder },
      'Unhandled IPC task handler error',
    );
    writeTaskIpcResponse(
      sourceAgentFolder,
      data.taskId,
      {
        ok: false,
        code: 'internal_error',
        error: err instanceof Error ? err.message : String(err),
      },
      data.authThreadId,
      data.responseKeyId,
    );
  }
}
