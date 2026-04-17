import { AGENT_ROOT } from '../core/config.js';
import { logger } from '../core/logger.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { validateRuntimePreflight } from '../cli/runtime-preflight.js';
import { TaskHandler } from './ipc-task-types.js';
import {
  restartServiceForRuntimeHome,
  toTrimmedString,
  writeTaskIpcResponse,
} from './ipc-task-shared.js';

const refreshGroupsHandler: TaskHandler = async (context) => {
  const { sourceGroup, isMain, deps, registeredGroups } = context;
  if (isMain) {
    logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
    await deps.syncGroups(true);
    const availableGroups = deps.getAvailableGroups();
    deps.writeGroupsSnapshot(
      sourceGroup,
      true,
      availableGroups,
      new Set(Object.keys(registeredGroups)),
    );
    return;
  }
  logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
};

const registerAgentHandler: TaskHandler = (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups } = context;
  const taskId = toTrimmedString(data.taskId, { maxLen: 128 });
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized register_agent attempt blocked');
    writeTaskIpcResponse(sourceGroup, taskId, {
      ok: false,
      error: 'Only the main agent can register new agents.',
    });
    return;
  }
  if (data.jid && data.name && data.folder && data.trigger) {
    if (!isValidGroupFolder(data.folder)) {
      logger.warn(
        { sourceGroup, folder: data.folder },
        'Invalid register_agent request - unsafe folder name',
      );
      writeTaskIpcResponse(sourceGroup, taskId, {
        ok: false,
        error: `Invalid agent folder: ${data.folder}`,
      });
      return;
    }
    const existingGroup = registeredGroups[data.jid];
    deps.registerGroup(data.jid, {
      name: data.name,
      folder: data.folder,
      trigger: data.trigger,
      added_at: new Date().toISOString(),
      agentConfig: data.agentConfig,
      requiresTrigger: data.requiresTrigger,
      isMain: existingGroup?.isMain,
    });
    writeTaskIpcResponse(sourceGroup, taskId, {
      ok: true,
      message: `Agent "${data.name}" registered.`,
    });
    return;
  }
  logger.warn(
    { data },
    'Invalid register_agent request - missing required fields',
  );
  writeTaskIpcResponse(sourceGroup, taskId, {
    ok: false,
    error: 'Missing required fields: jid, name, folder, trigger.',
  });
};

const serviceRestartHandler: TaskHandler = (context) => {
  const { data, sourceGroup, isMain } = context;
  const taskId = toTrimmedString(data.taskId, { maxLen: 128 });
  if (!isMain) {
    logger.warn(
      { sourceGroup },
      'Unauthorized service_restart attempt blocked',
    );
    writeTaskIpcResponse(sourceGroup, taskId, {
      ok: false,
      error: 'Only the main agent can restart the service.',
    });
    return;
  }

  try {
    const validation = validateRuntimePreflight(AGENT_ROOT);
    if (!validation.ok) {
      writeTaskIpcResponse(sourceGroup, taskId, {
        ok: false,
        error:
          validation.failure?.summary ||
          'Runtime configuration validation failed.',
        details: validation.failure?.details || [],
      });
      return;
    }

    writeTaskIpcResponse(sourceGroup, taskId, {
      ok: true,
      message: 'Service restart accepted. Restarting now.',
    });

    setTimeout(() => {
      const restartOutcome = restartServiceForRuntimeHome(AGENT_ROOT);
      if (!restartOutcome.ok) {
        logger.error(
          { sourceGroup, taskId, error: restartOutcome.message },
          'Service restart failed after acknowledgment',
        );
        return;
      }
      logger.info(
        { sourceGroup, taskId, message: restartOutcome.message },
        'Service restart completed',
      );
    }, 0);
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Service restart failed with an unexpected error.';
    logger.error(
      { sourceGroup, taskId, err },
      'Error while handling service_restart IPC task',
    );
    writeTaskIpcResponse(sourceGroup, taskId, {
      ok: false,
      error: message,
    });
  }
};

export const adminTaskHandlers: Record<string, TaskHandler> = {
  refresh_groups: refreshGroupsHandler,
  register_agent: registerAgentHandler,
  service_restart: serviceRestartHandler,
};
