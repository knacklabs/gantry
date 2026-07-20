import { logger } from '../infrastructure/logging/logger.js';
import { IpcDeps } from '../runtime/ipc-domain-types.js';
import { parseAgentThreadQueueKey } from '../shared/thread-queue-key.js';
import { adminTaskHandlers } from './ipc-admin-handlers.js';
import { agentProfileTaskHandlers } from './ipc-agent-profile-handlers.js';
import { fileArtifactTaskHandlers } from './ipc-file-artifact-handlers.js';
import { agentTaskLifecycleHandlers } from './ipc-agent-task-lifecycle-handlers.js';
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
import {
  isLockedDeniedIpcTaskType,
  resolveAgentLockStatus,
  type AgentLockStatus,
} from '../config/profiles.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { incrementOperationalError } from '../shared/operational-error-counters.js';
import {
  beginDurablePermissionInteraction,
  durablePermissionRequestSnapshot,
} from '../application/interactions/durable-interaction-handler.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../domain/types.js';

const DENIED_BY_PROFILE_REASON = 'denied_by_profile';

export async function requestDurableTaskPermissionApproval(
  request: PermissionApprovalRequest,
  prompt: (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>,
): Promise<PermissionApprovalDecision> {
  await beginDurablePermissionInteraction({
    request,
    sourceAgentFolder: request.sourceAgentFolder,
    payload: {
      sourceAgentFolder: request.sourceAgentFolder,
      requestId: request.requestId,
      toolName: request.toolName,
      targetJid: request.targetJid ?? null,
      agentId: request.agentId ?? null,
      jobId: request.jobId ?? null,
      request: durablePermissionRequestSnapshot(request),
    },
    callbackRoute: null,
  });
  return prompt(request);
}

async function denyLockedIpcTask(
  data: TaskIpcData,
  sourceAgentFolder: string,
  deps: IpcDeps,
  lockStatus: Exclude<AgentLockStatus, 'full'>,
): Promise<void> {
  logger.warn(
    {
      type: data.type,
      sourceAgentFolder,
      reason: DENIED_BY_PROFILE_REASON,
      accessPreset: lockStatus,
    },
    'Denied locked-agent IPC task at parent boundary',
  );
  await deps
    .publishRuntimeEvent?.({
      appId: (data.appId ?? 'default') as never,
      agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder) as never,
      conversationId: data.chatJid as never,
      threadId: data.authThreadId as never,
      eventType: RUNTIME_EVENT_TYPES.PERMISSION_DENIED,
      actor: `agent:${sourceAgentFolder}`,
      payload: {
        taskType: data.type,
        reasonCode: DENIED_BY_PROFILE_REASON,
        // 'unknown' marks a fail-closed denial: the settings desired state
        // could not be read at decision time.
        accessPreset: lockStatus,
      },
    })
    .catch((err) => {
      logger.error(
        { err, type: data.type, sourceAgentFolder },
        'Failed to publish denied_by_profile audit event',
      );
    });
  writeTaskIpcResponse(
    sourceAgentFolder,
    data.taskId,
    {
      ok: false,
      code: DENIED_BY_PROFILE_REASON,
      error:
        lockStatus === 'locked'
          ? 'This agent runs with a locked access preset. Skill install, MCP server, access, settings, and admin requests are disabled; provision capabilities before the run.'
          : 'Agent access preset could not be verified; authority-changing requests fail closed. Retry after the runtime settings are readable.',
    },
    data.authThreadId,
    data.responseKeyId,
  );
}

const taskHandlers: Record<string, TaskHandler> = {
  ...schedulerCreateTaskHandlers,
  ...schedulerMutateTaskHandlers,
  ...schedulerQueryTaskHandlers,
  ...adminTaskHandlers,
  ...agentProfileTaskHandlers,
  ...fileArtifactTaskHandlers,
  ...agentTaskLifecycleHandlers,
};

export type { TaskIpcData } from './ipc-types.js';

export async function processTaskIpc(
  data: TaskIpcData,
  sourceAgentFolder: string,
  deps: IpcDeps,
  ipcBaseDir?: string,
): Promise<void> {
  const conversationBindings = deps.conversationRoutes();
  // Same-channel authorization compares against the CHAT jid (data.chatJid),
  // so derive the set of chat jids the agent is bound to from each route key's
  // parsed chatJid — not the raw (possibly agent/provider-qualified) queue key,
  // which would only match when a bare-key route happened to exist.
  const sourceAgentFolderJids = Array.from(
    new Set(
      Object.entries(conversationBindings)
        .filter(([, group]) => group.folder === sourceAgentFolder)
        .map(([key]) => parseAgentThreadQueueKey(key).chatJid),
    ),
  );

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

  // Parent-side security boundary: locked agents can never invoke
  // authority-changing/request/admin/settings IPC tasks. A forged IPC file in a
  // locked agent's runner workspace is denied here even though the child never
  // mounted the tool. An unreadable lock status ('unknown') fails closed on
  // these authority-bearing task types only.
  if (isLockedDeniedIpcTaskType(data.type)) {
    const lockStatus = resolveAgentLockStatus(sourceAgentFolder);
    if (lockStatus !== 'full') {
      await denyLockedIpcTask(data, sourceAgentFolder, deps, lockStatus);
      return;
    }
  }

  const resolvedDeps = {
    ...deps,
    requestPermissionApproval: (request: PermissionApprovalRequest) =>
      requestDurableTaskPermissionApproval(
        request,
        deps.requestPermissionApproval,
      ),
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
    getAgentRepository:
      deps.getAgentRepository ??
      (() => {
        try {
          return getRuntimeStorage().repositories.agents;
        } catch {
          return undefined;
        }
      }),
    getSkillRepository:
      deps.getSkillRepository ??
      (() => {
        try {
          return getRuntimeStorage().repositories.skills;
        } catch {
          return undefined;
        }
      }),
    getAsyncTaskRepository:
      deps.getAsyncTaskRepository ??
      (() => {
        try {
          return getRuntimeStorage().repositories.asyncTasks;
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
    getFileArtifactStore:
      deps.getFileArtifactStore ??
      (() => {
        try {
          return getRuntimeStorage().fileArtifacts;
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
    incrementOperationalError('ipc', 'task_dispatch');
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
