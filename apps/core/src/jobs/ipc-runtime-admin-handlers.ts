import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, MYCLAW_HOME } from '../config/index.js';
import {
  getRuntimeSettingsRevision,
  readRuntimeSettingsYaml,
  saveRuntimeSettings,
  updateRuntimeSettingsIfRevision,
} from '../config/settings/runtime-settings.js';
import { parseRuntimeSettings } from '../config/settings/runtime-settings-parser.js';
import { renderRuntimeSettingsYaml } from '../config/settings/runtime-settings-renderer.js';
import { validateLoadedRuntimeSettings } from '../config/settings/runtime-settings-validation.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import { SettingsDesiredStateService } from '../config/settings/desired-state-service.js';
import { logger } from '../infrastructure/logging/logger.js';
import { validateRuntimePreflightWithStorage } from '../config/preflight.js';
import { TaskHandler } from './ipc-types.js';
import type { PermissionApprovalDecision } from '../domain/types.js';
import type { IpcDeps } from '../runtime/ipc-domain-types.js';
import {
  appendPermissionRule,
  canonicalizePermissionRule,
} from '../shared/permission-rules.js';
import {
  createTaskResponder,
  restartServiceForRuntimeHome,
  toTrimmedString,
} from './ipc-shared.js';

export interface CapabilityReviewForPermission {
  toolName: string;
  requestKind: string;
  displayName: string;
  reason: string;
  toolInput: Record<string, unknown>;
}

function validateSameChannelApprovalTarget(input: {
  data: Parameters<TaskHandler>[0]['data'];
  sourceGroupJids: string[];
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
    !input.sourceGroupJids.includes(requestedTargetJid)
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
  const { data, sourceGroup, isMain } = context;
  const taskId = toTrimmedString(data.taskId, { maxLen: 128 });
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    taskId,
    data.authThreadId,
  );
  if (!isMain) {
    logger.warn(
      { sourceGroup },
      'Unauthorized service_restart attempt blocked',
    );
    reject('Only the main agent can restart the service.', 'forbidden');
    return;
  }

  try {
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

    accept('Service restart accepted. Restarting now.');

    setTimeout(() => {
      const restartOutcome = restartServiceForRuntimeHome(MYCLAW_HOME);
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
    reject(message, 'internal_error');
  }
};

export const settingsDesiredStateHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  if (!isMain) {
    reject(
      'Only the main agent can read the full local settings desired state.',
      'forbidden',
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
  const { data, deps, sourceGroup, sourceGroupJids, isMain } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  if (!isMain) {
    reject(
      'Only the main agent can request global settings.yaml updates.',
      'forbidden',
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
    sourceGroupJids,
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
        sourceGroup,
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
      saveRuntimeSettings(MYCLAW_HOME, parsed);
      message =
        'Approved settings update. settings.yaml was written; safe changes reload automatically and restart may be required for topology changes.';
      accept(message, 'settings_updated');
    } catch (err) {
      logger.error({ err, sourceGroup }, 'Settings update review failed');
      message = `Rejected settings update: ${err instanceof Error ? err.message : 'permission review failed'}.`;
      reject(message, 'permission_review_failed');
    }
    await deps.sendMessage(
      requestedTargetJid,
      message,
      data.authThreadId ? { threadId: data.authThreadId } : undefined,
    );
  })().catch((err) =>
    logger.error({ err, sourceGroup }, 'Settings update final message failed'),
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

export function startRequestOnlyCapabilityReview(input: {
  deps: IpcDeps;
  sourceGroup: string;
  targetJid: string;
  threadId?: string;
  review: CapabilityReviewForPermission;
}): void {
  void completeCapabilityReview(input).catch((err) =>
    logger.error(
      { err, sourceGroup: input.sourceGroup, toolName: input.review.toolName },
      'Capability permission review final message failed',
    ),
  );
}

async function completeCapabilityReview(input: {
  deps: IpcDeps;
  sourceGroup: string;
  targetJid: string;
  threadId?: string;
  review: CapabilityReviewForPermission;
}): Promise<void> {
  let message: string;
  try {
    const isToolEnable = input.review.toolName === 'request_tool_enable';
    const temporaryOnly = input.review.toolInput.temporaryOnly === true;
    const expectedSettingsRevision =
      isToolEnable && !temporaryOnly
        ? getRuntimeSettingsRevision(MYCLAW_HOME)
        : undefined;
    const decision = await input.deps.requestPermissionApproval({
      requestId: `capability-${input.review.toolName}-${randomUUID()}`,
      sourceGroup: input.sourceGroup,
      targetJid: input.targetJid,
      threadId: input.threadId,
      decisionPolicy: 'same_channel',
      toolName: input.review.toolName,
      displayName: input.review.displayName,
      title: isToolEnable
        ? 'Approve scoped tool permission'
        : `Approve ${input.review.requestKind.toLowerCase()} request`,
      description: isToolEnable
        ? 'Approving once allows only this current action. Approving the rule writes settings.yaml and updates future agent permissions.'
        : 'Only configured approvers can decide this request. This records the permission review only and does not enable the capability directly.',
      decisionReason: input.review.reason,
      approvalScope: temporaryOnly ? 'temporary' : 'persistent',
      decisionOptions: isToolEnable
        ? temporaryOnly
          ? ['approve_once', 'reject']
          : ['approve_permanent', 'approve_once', 'reject']
        : undefined,
      permissionRule: isToolEnable
        ? describeToolEnableRule(
            String(input.review.toolInput.permissionRule || ''),
          )
        : undefined,
      toolInput: input.review.toolInput,
    });
    message = isToolEnable
      ? await finalizeToolEnableDecision({
          sourceGroup: input.sourceGroup,
          displayName: input.review.displayName,
          canonicalRule: String(input.review.toolInput.permissionRule || ''),
          expectedSettingsRevision,
          decision,
        })
      : requestOnlyReviewReceipt(input.review.displayName, decision);
  } catch (err) {
    logger.error(
      { err, sourceGroup: input.sourceGroup, toolName: input.review.toolName },
      'Capability permission review failed',
    );
    message = `Rejected ${input.review.displayName}: ${
      err instanceof Error ? err.message : 'permission review failed'
    }. No capability was enabled.`;
  }
  await input.deps.sendMessage(
    input.targetJid,
    message,
    input.threadId ? { threadId: input.threadId } : undefined,
  );
}

function requestOnlyReviewReceipt(
  displayName: string,
  decision: PermissionApprovalDecision,
): string {
  const reason = decision.approved
    ? 'missing approving principal'
    : decision.reason || 'not approved';
  return decision.approved && decision.decidedBy
    ? `Approved ${displayName}. Permission review recorded by ${decision.decidedBy}; no capability was enabled by this request-only flow.`
    : `Rejected ${displayName}: ${reason}. No capability was enabled.`;
}

function describeToolEnableRule(canonicalRule: string) {
  const described = canonicalizePermissionRule({
    toolName: canonicalRule.startsWith('mcp__')
      ? canonicalRule
      : canonicalRule.replace(/\(.*\)$/, ''),
    rule: canonicalRule.match(/^[^(]+\((.*)\)$/)?.[1],
  });
  return {
    canonical: described.canonical,
    risk: described.risk,
    riskReason: described.riskReason,
    broad: described.broad,
    examples: described.examples,
    boundary: described.boundary,
  };
}

async function finalizeToolEnableDecision(input: {
  sourceGroup: string;
  displayName: string;
  canonicalRule: string;
  expectedSettingsRevision?: string;
  decision: PermissionApprovalDecision;
}): Promise<string> {
  if (!input.decision.approved || !input.decision.decidedBy) {
    return `Rejected ${input.displayName}: ${
      input.decision.reason || 'not approved'
    }. No permission rule was added.`;
  }
  if (input.decision.mode !== 'approve_permanent') {
    writeOneTimePermissionRule(input.sourceGroup, input.canonicalRule);
    return `Approved once: ${input.canonicalRule}. This matching tool use can proceed once; no persistent permission rule was added.`;
  }
  if (!input.expectedSettingsRevision) {
    return `Rejected ${input.displayName}: missing settings revision. Ask the agent to retry.`;
  }
  const settings = updateRuntimeSettingsIfRevision(
    MYCLAW_HOME,
    input.expectedSettingsRevision,
    (settings) => {
      const agent = settings.agents[input.sourceGroup];
      if (!agent) {
        throw new Error(
          `agent ${input.sourceGroup} is not present in settings.yaml`,
        );
      }
      agent.capabilities.permissionRules = appendPermissionRule(
        agent.capabilities.permissionRules,
        'allow',
        input.canonicalRule,
      );
      return settings;
    },
  );
  if (!settings) {
    return `Rejected ${input.displayName}: settings.yaml changed while approval was pending. Ask the agent to retry.`;
  }
  const storage = getRuntimeStorage();
  try {
    await new SettingsDesiredStateService({
      ops: storage.ops,
      repositories: storage.repositories,
    }).reconcile(settings);
  } catch (err) {
    updateRuntimeSettingsIfRevision(
      MYCLAW_HOME,
      getRuntimeSettingsRevision(MYCLAW_HOME),
      (current) => {
        const agent = current.agents[input.sourceGroup];
        if (agent) {
          agent.capabilities.permissionRules.allow =
            agent.capabilities.permissionRules.allow.filter(
              (rule) => rule !== input.canonicalRule,
            );
        }
        return current;
      },
    );
    throw err;
  }
  return `Approved permanently: ${input.canonicalRule}. Changed settings.yaml and updated agent permissions.`;
}

function writeOneTimePermissionRule(
  sourceGroup: string,
  canonicalRule: string,
) {
  const dir = path.join(
    DATA_DIR,
    'ipc',
    sourceGroup,
    'one-time-permission-rules',
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, `${randomUUID()}.json`),
    JSON.stringify(
      { rule: canonicalRule, createdAt: new Date().toISOString() },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
