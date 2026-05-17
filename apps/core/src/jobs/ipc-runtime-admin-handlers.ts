import { randomUUID } from 'node:crypto';

import { MYCLAW_HOME } from '../config/index.js';
import {
  getRuntimeSettingsRevision,
  readRuntimeSettingsYaml,
} from '../config/settings/runtime-settings.js';
import { parseRuntimeSettings } from '../config/settings/runtime-settings-parser.js';
import { validateLoadedRuntimeSettings } from '../config/settings/runtime-settings-validation.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import { SettingsDesiredStateService } from '../config/settings/desired-state-service.js';
import { applyRuntimeSettingsDesiredState } from '../config/settings/restart-sync.js';
import { logger } from '../infrastructure/logging/logger.js';
import { validateRuntimePreflightWithStorage } from '../config/preflight.js';
import { TaskHandler } from './ipc-types.js';
import {
  createTaskResponder,
  restartServiceForRuntimeHome,
  toTrimmedString,
} from './ipc-shared.js';
import {
  adminCapabilityRequiredMessage,
  sourceAgentHasAdminToolCapability,
} from './ipc-admin-authorization.js';
import { memoryAgentIdForGroupFolder } from '../memory/app-memory-boundaries.js';

function validateSameChannelApprovalTarget(input: {
  data: Parameters<TaskHandler>[0]['data'];
  sourceAgentFolderJids: string[];
  requestKind: string;
  reject: (error: string, code?: string, details?: string[]) => void;
}): string | null {
  const requestedTargetJid = toTrimmedString(input.data.chatJid, {
    maxLen: 512,
  });
  const targetOverride = toTrimmedString(
    input.data.targetJid || input.data.jid,
    { maxLen: 512 },
  );
  if (targetOverride && targetOverride !== requestedTargetJid) {
    input.reject(
      `${input.requestKind} requests must use the originating chat as the approval target.`,
      'forbidden',
    );
    return null;
  }
  if (
    !requestedTargetJid ||
    !input.sourceAgentFolderJids.includes(requestedTargetJid)
  ) {
    input.reject(
      `${input.requestKind} requests must include the originating chat for this agent.`,
      'forbidden',
    );
    return null;
  }
  return requestedTargetJid;
}

export const serviceRestartHandler: TaskHandler = async (context) => {
  const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
  const taskId = toTrimmedString(data.taskId, { maxLen: 128 });
  const { accept, reject } = createTaskResponder(
    sourceAgentFolder,
    taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  if (!(await sourceAgentHasAdminToolCapability(context, 'service_restart'))) {
    logger.warn(
      { sourceAgentFolder },
      'Unauthorized service_restart attempt blocked',
    );
    reject(
      adminCapabilityRequiredMessage('service_restart'),
      'missing_capability',
    );
    return;
  }

  try {
    const requestedTargetJid = validateSameChannelApprovalTarget({
      data,
      sourceAgentFolderJids,
      requestKind: 'Service restart',
      reject,
    });
    if (!requestedTargetJid) return;
    if (
      typeof deps.requestPermissionApproval !== 'function' ||
      typeof deps.sendMessage !== 'function'
    ) {
      reject(
        'Service restart requests require a configured approval surface.',
        'preflight_failed',
      );
      return;
    }
    const validation = await validateRuntimePreflightWithStorage(MYCLAW_HOME);
    if (!validation.ok) {
      reject(
        validation.failure?.summary ||
          'Runtime configuration validation failed.',
        'preflight_failed',
        validation.failure?.details || [],
      );
      return;
    }
    const reason =
      toTrimmedString(data.payload?.reason, { maxLen: 2000 }) ||
      'Agent requested a runtime service restart.';
    const decision = await deps.requestPermissionApproval({
      requestId: `service-restart-${randomUUID()}`,
      appId: data.appId as never,
      agentId: memoryAgentIdForGroupFolder(sourceAgentFolder) as never,
      sourceAgentFolder,
      targetJid: requestedTargetJid,
      threadId: data.authThreadId,
      decisionPolicy: 'same_channel',
      toolName: 'service_restart',
      displayName: 'Service restart',
      title: 'Approve service restart',
      description:
        'Approving restarts the local Gantry runtime service after runtime preflight passes.',
      decisionReason: reason,
      toolInput: {
        runtimeHome: MYCLAW_HOME,
        activation: 'immediate_service_restart',
      },
    });
    if (!decision.approved || !decision.decidedBy) {
      const message = `Rejected service restart: ${decision.reason || 'not approved'}.`;
      reject(message, 'permission_denied');
      await deps.sendMessage(
        requestedTargetJid,
        message,
        data.authThreadId ? { threadId: data.authThreadId } : undefined,
      );
      return;
    }

    accept('Service restart accepted. Restarting now.');

    setTimeout(() => {
      const restartOutcome = restartServiceForRuntimeHome(MYCLAW_HOME);
      if (!restartOutcome.ok) {
        logger.error(
          { sourceAgentFolder, taskId, error: restartOutcome.message },
          'Service restart failed after acknowledgment',
        );
        return;
      }
      logger.info(
        { sourceAgentFolder, taskId, message: restartOutcome.message },
        'Service restart completed',
      );
    }, 0);
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Service restart failed with an unexpected error.';
    logger.error(
      { sourceAgentFolder, taskId, err },
      'Error while handling service_restart IPC task',
    );
    reject(message, 'internal_error');
  }
};

export const settingsDesiredStateHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  if (
    !(await sourceAgentHasAdminToolCapability(
      context,
      'settings_desired_state',
    ))
  ) {
    reject(
      adminCapabilityRequiredMessage('settings_desired_state'),
      'missing_capability',
    );
    return;
  }
  try {
    acceptData('Current settings desired state loaded.', {
      yaml: readRuntimeSettingsYaml(MYCLAW_HOME),
      revision: getRuntimeSettingsRevision(MYCLAW_HOME),
    });
  } catch (err) {
    reject(
      err instanceof Error ? err.message : 'Failed to read settings.yaml.',
      'invalid_settings',
    );
  }
};

export const requestSettingsUpdateHandler: TaskHandler = async (context) => {
  const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
  const { accept, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  if (
    !(await sourceAgentHasAdminToolCapability(
      context,
      'request_settings_update',
    ))
  ) {
    reject(
      adminCapabilityRequiredMessage('request_settings_update'),
      'missing_capability',
    );
    return;
  }
  const payload = data.payload || {};
  const replacementYaml = toTrimmedString(payload.replacementYaml, {
    maxLen: 256_000,
  });
  const expectedRevision = toTrimmedString(payload.expectedRevision, {
    maxLen: 128,
  });
  const reason = toTrimmedString(payload.reason, { maxLen: 2000 });
  if (!replacementYaml || !expectedRevision || !reason) {
    reject(
      'Missing required fields: replacementYaml, expectedRevision, and reason.',
      'invalid_request',
    );
    return;
  }
  const currentRevision = getRuntimeSettingsRevision(MYCLAW_HOME);
  if (expectedRevision !== currentRevision) {
    reject(
      'settings.yaml changed since it was read. Reload settings_desired_state and retry with the latest revision.',
      'stale_settings',
    );
    return;
  }
  const beforeYaml = readRuntimeSettingsYaml(MYCLAW_HOME);
  const requestedTargetJid = validateSameChannelApprovalTarget({
    data,
    sourceAgentFolderJids,
    requestKind: 'Settings update',
    reject,
  });
  if (!requestedTargetJid) return;
  if (
    typeof deps.requestPermissionApproval !== 'function' ||
    typeof deps.sendMessage !== 'function'
  ) {
    reject(
      'Settings update requests require a configured approval surface.',
      'preflight_failed',
    );
    return;
  }
  let parsed;
  try {
    parsed = parseRuntimeSettings(replacementYaml);
  } catch (err) {
    reject(
      err instanceof Error ? err.message : 'settings.yaml did not parse.',
      'invalid_settings',
    );
    return;
  }
  const validation = validateLoadedRuntimeSettings(MYCLAW_HOME, parsed);
  if (!validation.ok) {
    reject(
      validation.failure?.summary || 'settings.yaml validation failed.',
      'invalid_settings',
      validation.failure?.details || [],
    );
    return;
  }
  const storage = getRuntimeStorage();
  const desiredState = new SettingsDesiredStateService({
    ops: storage.ops,
    repositories: storage.repositories,
  });
  const invalidReferences =
    await desiredState.validateCapabilityReferences(parsed);
  if (invalidReferences.length > 0) {
    reject(
      'settings.yaml contains unavailable capability references.',
      'invalid_settings',
      invalidReferences,
    );
    return;
  }

  void (async () => {
    let message: string;
    try {
      const decision = await deps.requestPermissionApproval({
        requestId: `settings-${randomUUID()}`,
        appId: data.appId as never,
        agentId: memoryAgentIdForGroupFolder(sourceAgentFolder) as never,
        sourceAgentFolder,
        targetJid: requestedTargetJid,
        threadId: data.authThreadId,
        decisionPolicy: 'same_channel',
        toolName: 'request_settings_update',
        displayName: 'Settings desired-state update',
        title: 'Approve settings.yaml update',
        description:
          'Approving writes validated local desired-state settings.yaml. Safe changes reload automatically; some topology changes may require restart.',
        decisionReason: reason,
        toolInput: {
          authoritative: parsed.desiredState.authoritative,
          agentCount: Object.keys(parsed.agents).length,
          providerIds: Object.keys(parsed.providers),
          expectedRevision,
          diffSummary: summarizeYamlDiff(beforeYaml, replacementYaml),
          activation: 'local_settings_yaml',
        },
      });
      if (!decision.approved || !decision.decidedBy) {
        message = `Rejected settings update: ${decision.reason || 'not approved'}.`;
        reject(message, 'permission_denied');
        await deps.sendMessage(
          requestedTargetJid,
          message,
          data.authThreadId ? { threadId: data.authThreadId } : undefined,
        );
        return;
      }
      if (getRuntimeSettingsRevision(MYCLAW_HOME) !== expectedRevision) {
        message =
          'Rejected settings update: settings.yaml changed while approval was pending. Reload settings_desired_state and retry.';
        reject(message, 'stale_settings');
        await deps.sendMessage(
          requestedTargetJid,
          message,
          data.authThreadId ? { threadId: data.authThreadId } : undefined,
        );
        return;
      }
      const finalInvalidReferences =
        await desiredState.validateCapabilityReferences(parsed);
      if (finalInvalidReferences.length > 0) {
        message =
          'Rejected settings update: capability references changed while approval was pending.';
        reject(message, 'invalid_settings', finalInvalidReferences);
        await deps.sendMessage(
          requestedTargetJid,
          message,
          data.authThreadId ? { threadId: data.authThreadId } : undefined,
        );
        return;
      }
      await applyRuntimeSettingsDesiredState({
        runtimeHome: MYCLAW_HOME,
        settings: parsed,
        previousSettings: parseRuntimeSettings(beforeYaml),
        ops: storage.ops,
        repositories: storage.repositories,
        reloadRuntimeState: deps.reloadRuntimeState,
      });
      message =
        'Approved settings update. settings.yaml was written and reconciled; restart may be required for topology changes.';
      accept(message, 'settings_updated');
    } catch (err) {
      logger.error({ err, sourceAgentFolder }, 'Settings update review failed');
      message = `Rejected settings update: ${err instanceof Error ? err.message : 'permission review failed'}.`;
      reject(message, 'permission_review_failed');
    }
    await deps.sendMessage(
      requestedTargetJid,
      message,
      data.authThreadId ? { threadId: data.authThreadId } : undefined,
    );
  })().catch((err) =>
    logger.error(
      { err, sourceAgentFolder },
      'Settings update final message failed',
    ),
  );
};

function summarizeYamlDiff(before: string, after: string): string[] {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);
  const diff: string[] = [];
  for (let index = 0; index < max; index += 1) {
    const left = beforeLines[index] ?? '';
    const right = afterLines[index] ?? '';
    if (left === right) continue;
    if (left) diff.push(`- ${index + 1}: ${left}`);
    if (right) diff.push(`+ ${index + 1}: ${right}`);
    if (diff.length >= 80) {
      diff.push(`... truncated after ${diff.length} changed lines`);
      break;
    }
  }
  return diff;
}
