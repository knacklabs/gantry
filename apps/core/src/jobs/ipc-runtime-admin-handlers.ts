import { randomUUID } from 'node:crypto';

import { GANTRY_HOME, getRuntimeSettingsForConfig } from '../config/index.js';
import {
  getRuntimeSettingsRevision,
  readRuntimeSettingsYaml,
} from '../config/settings/runtime-settings.js';
import { buildControlPlaneReadModelFromRepositories } from '../application/control-plane/control-plane-storage-model.js';
import { GuidedActionService } from '../application/guided-actions/guided-action-service.js';
import { resolveControlPlaneGuidedAction } from '../application/guided-actions/guided-action-model.js';
import type { AppId } from '../domain/app/app.js';
import { parseRuntimeSettings } from '../config/settings/runtime-settings-parser.js';
import { validateLoadedRuntimeSettings } from '../config/settings/runtime-settings-validation.js';
import {
  getRuntimeRepositories,
  getRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import { SettingsDesiredStateService } from '../config/settings/desired-state-service.js';
import { importWorkstationSettings } from '../config/settings/settings-import-service.js';
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
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import type { RuntimeSettings } from '../config/settings/runtime-settings-types.js';
import {
  findConversationRoutesForChat,
  parseAgentThreadQueueKey,
} from '../shared/thread-queue-key.js';
import { resolveEffectivePermissionMode } from '../shared/permission-mode.js';

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
    const validation = await validateRuntimePreflightWithStorage(GANTRY_HOME);
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
      agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder) as never,
      sourceAgentFolder,
      targetJid: requestedTargetJid,
      threadId: data.authThreadId,
      decisionPolicy: 'same_channel',
      decisionOptions: ['allow_once', 'cancel'],
      toolName: 'service_restart',
      displayName: 'Service restart',
      title: 'Approve service restart',
      description:
        'Approving restarts the local Gantry runtime service after runtime preflight passes.',
      decisionReason: reason,
      toolInput: {
        runtimeHome: GANTRY_HOME,
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
      const restartOutcome = restartServiceForRuntimeHome(GANTRY_HOME);
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
      yaml: readRuntimeSettingsYaml(GANTRY_HOME),
      revision: getRuntimeSettingsRevision(GANTRY_HOME),
    });
  } catch (err) {
    reject(
      err instanceof Error ? err.message : 'Failed to read settings.yaml.',
      'invalid_settings',
    );
  }
};

export const guidedActionPreviewHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  if (
    !(await sourceAgentHasAdminToolCapability(context, 'guided_action_preview'))
  ) {
    reject(
      adminCapabilityRequiredMessage('guided_action_preview'),
      'missing_capability',
    );
    return;
  }
  try {
    const appId = (data.appId || 'default') as AppId;
    const model = await buildControlPlaneReadModelFromRepositories({
      appId,
      settings: getRuntimeSettingsForConfig(),
      jobsRepository: getRuntimeRepositories(),
      modelCredentialsRepository:
        getRuntimeStorage().repositories.modelCredentials,
      pendingAccessRequestsRepository:
        getRuntimeStorage().repositories.pendingAccessRequests,
    });
    const ref = resolveControlPlaneGuidedAction(model.nextAction);
    acceptData(
      'Guided action preview ready.',
      new GuidedActionService().preview(ref),
    );
  } catch (err) {
    reject(
      err instanceof Error
        ? err.message
        : 'Failed to build guided action preview.',
      'internal_error',
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
  const currentRevision = getRuntimeSettingsRevision(GANTRY_HOME);
  if (expectedRevision !== currentRevision) {
    reject(
      'settings.yaml changed since it was read. Reload settings_desired_state and retry with the latest revision.',
      'stale_settings',
    );
    return;
  }
  const beforeYaml = readRuntimeSettingsYaml(GANTRY_HOME);
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
  const validation = validateLoadedRuntimeSettings(GANTRY_HOME, parsed);
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
      const beforeSettings = parseRuntimeSettings(beforeYaml);
      const requestingInstall = resolveRequestingInstallIdentity({
        settings: beforeSettings,
        conversationBindings: context.conversationBindings,
        requestedTargetJid,
        sourceAgentFolder,
        threadId: data.authThreadId,
        providerAccountId: data.providerAccountId,
      });
      const decision = await deps.requestPermissionApproval({
        requestId: `settings-${randomUUID()}`,
        appId: data.appId as never,
        agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder) as never,
        sourceAgentFolder,
        targetJid: requestedTargetJid,
        threadId: data.authThreadId,
        decisionPolicy: 'same_channel',
        decisionOptions: ['allow_once', 'cancel'],
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
          replacementYaml,
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
      if (getRuntimeSettingsRevision(GANTRY_HOME) !== expectedRevision) {
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
      await importWorkstationSettings(
        {
          runtimeHome: GANTRY_HOME,
          ops: storage.ops,
          repositories: storage.repositories,
          previousSettings: beforeSettings,
          reloadRuntimeState: deps.reloadRuntimeState,
          revisionMirror: {
            settingsRevisions: storage.repositories.settingsRevisions,
            pool: storage.service?.pool,
            createdBy: `admin-settings-update:${sourceAgentFolder}`,
            logWarn: (context, warning) => logger.warn(context, warning),
          },
          revisionMirrorRequired: true,
        },
        parsed,
      );
      message = settingsUpdateSuccessMessage(
        beforeSettings,
        parsed,
        sourceAgentFolder,
        requestingInstall,
      );
      accept(message, 'settings_updated');
    } catch (err) {
      logger.error({ err, sourceAgentFolder }, 'Settings update review failed');
      reject(
        'The settings update could not be completed. Explain this in plain language and say you can try again after the setup issue is fixed.',
        'settings_review_failed',
      );
      return;
    }
  })().catch((err) =>
    logger.error(
      { err, sourceAgentFolder },
      'Settings update final message failed',
    ),
  );
};

function settingsUpdateSuccessMessage(
  before: RuntimeSettings,
  after: RuntimeSettings,
  sourceAgentFolder: string,
  requestingInstall: RequestingInstallIdentity | null,
): string {
  if (
    permissionPostureBecameAuto(
      before,
      after,
      sourceAgentFolder,
      requestingInstall,
    )
  ) {
    return "Done — I'll only check with you for risky actions now.";
  }
  if (
    !before.permissions.yoloMode.denylist.includes('rm *') &&
    after.permissions.yoloMode.denylist.includes('rm *')
  ) {
    return 'Done — shell rm commands will require approval across all conversations.';
  }
  return 'Done — I updated the settings.';
}

interface RequestingInstallIdentity {
  conversationId: string;
  installId: string;
}

function resolveRequestingInstallIdentity(input: {
  settings: RuntimeSettings;
  conversationBindings: Parameters<TaskHandler>[0]['conversationBindings'];
  requestedTargetJid: string;
  sourceAgentFolder: string;
  threadId?: string;
  providerAccountId?: string;
}): RequestingInstallIdentity | null {
  const identities = new Map<string, RequestingInstallIdentity>();
  const routes = findConversationRoutesForChat(
    input.conversationBindings,
    input.requestedTargetJid,
    input.threadId,
    input.providerAccountId,
  ).filter(([, route]) => route.folder === input.sourceAgentFolder);

  for (const [routeKey, route] of routes) {
    if (!route.conversationId) continue;
    const conversation = input.settings.conversations[route.conversationId];
    if (!conversation) continue;
    const parsedRoute = parseAgentThreadQueueKey(routeKey);
    const routeThreadId = parsedRoute.threadId?.trim() || undefined;
    const routeProviderAccountId =
      parsedRoute.providerAccountId ?? route.providerAccountId?.trim();
    for (const [installId, install] of Object.entries(
      conversation.installedAgents,
    )) {
      if (
        install.status !== 'active' ||
        install.agentId !== input.sourceAgentFolder ||
        (install.threadId?.trim() || undefined) !== routeThreadId ||
        (routeProviderAccountId &&
          install.providerAccountId !== routeProviderAccountId)
      ) {
        continue;
      }
      const identity = { conversationId: route.conversationId, installId };
      identities.set(
        `${identity.conversationId}:${identity.installId}`,
        identity,
      );
    }
  }

  return identities.size === 1 ? [...identities.values()][0]! : null;
}

function permissionPostureBecameAuto(
  before: RuntimeSettings,
  after: RuntimeSettings,
  sourceAgentFolder: string,
  requestingInstall: RequestingInstallIdentity | null,
): boolean {
  const beforeInstall = requestingInstall
    ? before.conversations[requestingInstall.conversationId]?.installedAgents[
        requestingInstall.installId
      ]
    : undefined;
  const afterInstall = requestingInstall
    ? after.conversations[requestingInstall.conversationId]?.installedAgents[
        requestingInstall.installId
      ]
    : undefined;
  const beforeMode = resolveEffectivePermissionMode(
    beforeInstall?.permissionMode,
    before.agents[sourceAgentFolder]?.permissionMode,
  );
  const afterMode = resolveEffectivePermissionMode(
    afterInstall?.permissionMode,
    after.agents[sourceAgentFolder]?.permissionMode,
  );
  return beforeMode !== 'auto' && afterMode === 'auto';
}

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
