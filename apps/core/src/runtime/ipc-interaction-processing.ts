import fs from 'fs';
import { createHash } from 'node:crypto';

import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
} from '../domain/types.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { PermissionManagementService } from '../application/permissions/permission-management-service.js';
import { recheckSetupPausedJobsAfterCapabilityUpdate } from '../application/jobs/job-permission-recovery.js';
import {
  formatDurableAccessRuleForEvent,
  formatDurableAccessRulesForUser,
} from '../shared/durable-access-policy.js';
import {
  permissionUpdateAllowedToolRules,
  persistentPermissionUpdates,
} from '../shared/permission-tool-rules.js';
import { redactSensitiveText } from '../shared/sensitive-material.js';
import { archiveIpcErrorFile } from './ipc-filesystem.js';
import {
  getIpcResponseSigningPrivateKey,
  sealIpcResponseSigningPrivateKey,
} from './ipc-auth.js';
import {
  durablePermissionCallbackId,
  durablePermissionRequestSnapshot,
} from './ipc-durable-permission.js';
import {
  isActiveRunLeaseForInteraction,
  recordPendingInteractionRequested,
  recordRunScopedTransientGrant,
  resolvePendingInteractionRecord,
} from '../application/interactions/pending-interaction-durability.js';
import {
  resolveAgentLockStatus,
  type AgentLockStatus,
} from '../config/profiles.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import type { IpcDeps } from './ipc-domain-types.js';
import {
  processPermissionIpcRequest,
  processUserQuestionIpcRequest,
  writePermissionIpcResponse,
  writeUserQuestionIpcResponse,
} from './ipc-interaction-handler.js';
import {
  permissionDecisionEventType,
  permissionDecisionName,
  permissionTelemetryContext,
} from './ipc-permission-telemetry.js';

type LogContext = Record<string, unknown>;
type IpcInteractionLogger = {
  info?(context: LogContext, message: string): void;
  warn(context: LogContext, message: string): void;
  error(context: LogContext, message: string): void;
};

class StaleScheduledPermissionLeaseError extends Error {
  constructor() {
    super('Scheduled permission request run lease is no longer active');
    this.name = 'StaleScheduledPermissionLeaseError';
  }
}

class StaleScheduledQuestionLeaseError extends Error {
  constructor() {
    super('Scheduled question request run lease is no longer active');
    this.name = 'StaleScheduledQuestionLeaseError';
  }
}

export function interactionInFlightKey(input: {
  sourceAgentFolder: string;
  kind: 'permission' | 'user-question';
  threadId?: string;
  requestId: string;
}): string {
  return [
    input.sourceAgentFolder,
    input.kind,
    input.threadId || '',
    input.requestId,
  ].join(':');
}

export function writePermissionInteractionFailure(input: {
  ipcBaseDir: string;
  sourceAgentFolder: string;
  requestId: string;
  responseNonce?: string;
  threadId?: string;
  responseKeyId?: string;
  reason?: string;
  logger: IpcInteractionLogger;
}): void {
  try {
    writePermissionIpcResponse(
      input.ipcBaseDir,
      input.sourceAgentFolder,
      {
        requestId: input.requestId,
        ...(input.responseNonce ? { responseNonce: input.responseNonce } : {}),
        approved: false,
        reason: input.reason ?? 'Failed to process permission request',
      },
      getIpcResponseSigningPrivateKey(
        input.sourceAgentFolder,
        input.threadId,
        input.responseKeyId,
      ),
    );
  } catch (err) {
    input.logger.warn(
      {
        sourceAgentFolder: input.sourceAgentFolder,
        requestId: input.requestId,
        err,
      },
      'Failed to write permission IPC denial fallback',
    );
  }
}

export function writeUserQuestionInteractionFailure(input: {
  ipcBaseDir: string;
  sourceAgentFolder: string;
  requestId: string;
  threadId?: string;
  responseKeyId?: string;
  logger: IpcInteractionLogger;
}): void {
  try {
    writeUserQuestionIpcResponse(
      input.ipcBaseDir,
      input.sourceAgentFolder,
      {
        requestId: input.requestId,
        answers: {},
      },
      getIpcResponseSigningPrivateKey(
        input.sourceAgentFolder,
        input.threadId,
        input.responseKeyId,
      ),
    );
  } catch (err) {
    input.logger.warn(
      {
        sourceAgentFolder: input.sourceAgentFolder,
        requestId: input.requestId,
        err,
      },
      'Failed to write user question IPC fallback response',
    );
  }
}

export async function processPermissionInteractionIpc(input: {
  request: PermissionApprovalRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
  ipcBaseDir: string;
  file: string;
  claimedPath: string;
  logger: IpcInteractionLogger;
}): Promise<void> {
  // Parent-side security boundary: locked agents never reach any permission
  // authority outcome (durable pending row, prompt, transient or persistent
  // grant). The gate runs before recordPendingInteractionRequested so a forged
  // permission-request file in a locked agent's runner workspace is denied
  // without ever creating durable state. An unreadable lock status ('unknown')
  // fails closed on this authority-bearing path.
  const lockStatus = resolveAgentLockStatus(input.sourceAgentFolder);
  if (lockStatus !== 'full') {
    await denyLockedPermissionInteraction(input, lockStatus);
    return;
  }
  try {
    const requestedContext = permissionTelemetryContext(input.request, {
      sourceAgentFolder: input.sourceAgentFolder,
      decision: 'requested',
    });
    input.logger.info?.(requestedContext, 'Permission requested');
    // Durable pending record first: the prompt may only render once the
    // interaction can survive a provider/control-plane restart.
    const recorded = await recordPendingInteractionRequested({
      kind: 'permission',
      sourceAgentFolder: input.sourceAgentFolder,
      requestId: input.request.requestId,
      appId: input.request.appId,
      runId: input.request.runId,
      runLeaseToken: input.request.runLeaseToken,
      runLeaseFencingVersion: input.request.runLeaseFencingVersion,
      payload: {
        ...requestedContext,
        decisionPolicy: input.request.decisionPolicy ?? null,
        permissionCallbackId: durablePermissionCallbackId(
          input.request.requestId,
        ),
        request: durablePermissionRequestSnapshot(input.request),
      },
      callbackRoute: {
        ipcBaseDir: input.ipcBaseDir,
        targetJid: input.request.targetJid ?? null,
        threadId: input.request.threadId ?? null,
        responseKeyId: input.request.responseKeyId ?? null,
        responsePrivateKeySeal:
          sealIpcResponseSigningPrivateKey(
            getIpcResponseSigningPrivateKey(
              input.sourceAgentFolder,
              input.request.threadId,
              input.request.responseKeyId,
            ),
          ) ?? null,
        responseNonce: input.request.responseNonce ?? null,
      },
    });
    if (!recorded)
      throw new Error('Permission prompt was not durably recorded');
    await publishPermissionRuntimeEvent(input.deps, input.request, {
      eventType: RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
      payload: requestedContext,
    });
    await assertActiveScheduledPermissionLease(input);
    const decision = await processPermissionIpcRequest(input.request, {
      requestPermissionApproval: input.deps.requestPermissionApproval,
    });
    await assertActiveScheduledPermissionLease(input);
    if (
      decision.approved === true &&
      decision.decisionClassification !== 'user_permanent' &&
      input.request.runId
    ) {
      // Transient authority stays run-scoped: bound to the active run lease
      // and gone when the lease ends. Only the persistent path below commits
      // durable grants.
      await recordRunScopedTransientGrant({
        appId: input.request.appId,
        runId: input.request.runId,
        runLeaseToken: input.request.runLeaseToken,
        runLeaseFencingVersion: input.request.runLeaseFencingVersion,
        grant: {
          toolName: input.request.toolName,
          mode: decision.mode,
          requestId: input.request.requestId,
        },
        expiresAtMs: decision.timedGrantExpiresAtMs,
      });
    }
    const decisionContext = permissionTelemetryContext(input.request, {
      sourceAgentFolder: input.sourceAgentFolder,
      decision: permissionDecisionName(decision),
      decisionMode: decision.mode,
      decidedBy: decision.decidedBy,
    });
    input.logger.info?.(decisionContext, 'Permission decided');
    await publishPermissionRuntimeEvent(input.deps, input.request, {
      eventType: permissionDecisionEventType(decision),
      payload: decisionContext,
    });
    const permissionService = new PermissionManagementService();
    if (
      decision.approved === true &&
      decision.mode === 'allow_persistent_rule' &&
      decision.decisionClassification === 'user_permanent' &&
      (decision.updatedPermissions?.length ?? 0) > 0
    ) {
      await assertActiveScheduledPermissionLease(input);
      const persistentScopeRequest = persistentPermissionScopeRequest(
        input.request,
      );
      const updatedPermissions = decision.updatedPermissions ?? [];
      const toolRepository = input.deps.getToolRepository?.();
      const mirrorAgentToolRulesToSettings =
        input.deps.mirrorAgentToolRulesToSettings;
      if (!toolRepository || !mirrorAgentToolRulesToSettings) {
        throw new Error(
          'Persistent permission approval requires tool repository and settings mirror',
        );
      }
      await permissionService.applyPersistentToolRuleGrant({
        appId: input.request.appId as never,
        agentId: (input.request.agentId ??
          `agent:${input.sourceAgentFolder}`) as never,
        sourceAgentFolder: input.sourceAgentFolder,
        updates: updatedPermissions,
        toolRepository,
        mcpServerRepository: input.deps.getMcpServerRepository?.(),
        mirrorAgentToolRulesToSettings,
        permissionRepository: input.deps.getPermissionRepository?.(),
        semanticCapabilityDefinitions:
          input.request.semanticCapabilityDefinitions,
        ipcDir: pathForGroupIpc(input.ipcBaseDir, input.sourceAgentFolder),
        runHandle: input.request.runHandle,
        requestId: input.request.requestId,
        actor: decision.decidedBy,
        conversationId: persistentScopeRequest.targetJid,
        threadId: persistentScopeRequest.threadId,
        runId: input.request.runId,
        jobId: input.request.jobId,
        reason: decision.reason,
      });
      const persistedContext = permissionTelemetryContext(
        persistentScopeRequest,
        {
          sourceAgentFolder: input.sourceAgentFolder,
          decision: 'persisted',
          persistedRules: permissionUpdateAllowedToolRules(
            decision.updatedPermissions,
          ).map(formatDurableAccessRuleForEvent),
        },
      );
      input.logger.info?.(persistedContext, 'Permission persisted');
      await publishPermissionRuntimeEvent(input.deps, persistentScopeRequest, {
        eventType: RUNTIME_EVENT_TYPES.PERMISSION_PERSISTED,
        payload: persistedContext,
      });
      const recovery = await recheckSetupPausedJobsAfterCapabilityUpdate({
        appId: input.request.appId,
        sourceAgentFolder: input.sourceAgentFolder,
        conversationJid: input.request.targetJid,
        jobId: input.request.jobId,
        opsRepository: input.deps.opsRepository,
        scheduler: {
          requestSchedulerSync: input.deps.onSchedulerChanged,
        },
        toolRepository,
        skillRepository: input.deps.getSkillRepository?.(),
        mcpServerRepository: input.deps.getMcpServerRepository?.(),
        capabilitySecretRepository:
          input.deps.getCapabilitySecretRepository?.(),
        credentialBroker: await input.deps.getCredentialBroker?.(),
        getBrowserStatus: input.deps.getBrowserStatus,
        publishRuntimeEvent: input.deps.publishRuntimeEvent,
      });
      await sendPermissionOutcomeMessage(input.deps, input.request, {
        text: formatPersistentPermissionOutcome({
          rules: permissionUpdateAllowedToolRules(decision.updatedPermissions),
          semanticCapabilityDefinitions:
            input.request.semanticCapabilityDefinitions,
          recovery,
        }),
      });
    } else {
      await permissionService.recordDecision({
        appId: input.request.appId as never,
        agentId: input.request.agentId as never,
        requestId: input.request.requestId,
        toolName: input.request.toolName,
        decision,
        permissionRepository: input.deps.getPermissionRepository?.(),
        conversationId: input.request.targetJid,
        threadId: input.request.threadId,
        runId: input.request.runId,
        jobId: input.request.jobId,
      });
    }
    if (decision.approved) {
      const resumedContext = permissionTelemetryContext(input.request, {
        sourceAgentFolder: input.sourceAgentFolder,
        decision: 'resumed',
        decisionMode: decision.mode,
      });
      input.logger.info?.(
        resumedContext,
        'Permission resumed current tool call',
      );
      await publishPermissionRuntimeEvent(input.deps, input.request, {
        eventType: RUNTIME_EVENT_TYPES.PERMISSION_RESUMED,
        payload: resumedContext,
      });
    }
    await publishPermissionRuntimeEvent(input.deps, input.request, {
      eventType: RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
      payload: permissionTelemetryContext(input.request, {
        sourceAgentFolder: input.sourceAgentFolder,
        decision: permissionDecisionName(decision),
        decisionMode: decision.mode,
        approved: decision.approved,
      }),
    });
    const responsePermissionUpdates = persistentPermissionUpdates(decision) as
      | PermissionApprovalDecision['updatedPermissions']
      | undefined;
    await assertActiveScheduledPermissionLease(input);
    const resolved = await resolvePendingInteractionRecord({
      kind: 'permission',
      sourceAgentFolder: input.sourceAgentFolder,
      requestId: input.request.requestId,
      appId: input.request.appId ?? null,
      runId: input.request.runId,
      status: decision.mode === 'cancel' ? 'cancelled' : 'resolved',
      resolution: {
        approved: decision.approved,
        mode: decision.mode,
        reason: decision.reason ?? null,
        updatedPermissions: responsePermissionUpdates ?? null,
        decisionClassification: decision.decisionClassification ?? null,
        timedGrantExpiresAtMs: decision.timedGrantExpiresAtMs ?? null,
      },
      approverRef: decision.decidedBy ?? null,
    });
    if (!resolved) {
      input.logger.warn(
        permissionTelemetryContext(input.request, {
          sourceAgentFolder: input.sourceAgentFolder,
          decision: permissionDecisionName(decision),
        }),
        'Withholding permission IPC response because durable resolution failed',
      );
      return;
    }
    await assertActiveScheduledPermissionLease(input);
    writePermissionIpcResponse(
      input.ipcBaseDir,
      input.sourceAgentFolder,
      {
        requestId: input.request.requestId,
        responseNonce: input.request.responseNonce,
        approved: decision.approved,
        mode: decision.mode,
        decidedBy: decision.decidedBy,
        reason: decision.reason,
        updatedPermissions: responsePermissionUpdates,
        decisionClassification: decision.decisionClassification,
        timedGrantExpiresAtMs: decision.timedGrantExpiresAtMs,
      },
      getIpcResponseSigningPrivateKey(
        input.sourceAgentFolder,
        input.request.threadId,
        input.request.responseKeyId,
      ),
    );
    fs.unlinkSync(input.claimedPath);
  } catch (err) {
    if (err instanceof StaleScheduledPermissionLeaseError) {
      await publishPermissionRuntimeEvent(input.deps, input.request, {
        eventType: RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
        payload: permissionTelemetryContext(input.request, {
          sourceAgentFolder: input.sourceAgentFolder,
          decision: 'cancelled',
          error: err.message,
        }),
      });
      archiveIpcErrorFile(
        input.ipcBaseDir,
        input.sourceAgentFolder,
        input.file,
        input.claimedPath,
      );
      return;
    }
    writePermissionInteractionFailure({
      ipcBaseDir: input.ipcBaseDir,
      sourceAgentFolder: input.sourceAgentFolder,
      requestId: input.request.requestId,
      responseNonce: input.request.responseNonce,
      threadId: input.request.threadId,
      responseKeyId: input.request.responseKeyId,
      logger: input.logger,
    });
    input.logger.error(
      {
        file: input.file,
        ...permissionTelemetryContext(input.request, {
          sourceAgentFolder: input.sourceAgentFolder,
          decision: 'failed',
        }),
        err,
      },
      'Error processing permission IPC request',
    );
    await publishPermissionRuntimeEvent(input.deps, input.request, {
      eventType: RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
      payload: permissionTelemetryContext(input.request, {
        sourceAgentFolder: input.sourceAgentFolder,
        decision: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    });
    await sendPermissionOutcomeMessage(input.deps, input.request, {
      text: `Permission request failed: ${err instanceof Error ? redactSensitiveText(err.message) : 'processing failed'}. No persistent permission was applied.`,
    });
    archiveIpcErrorFile(
      input.ipcBaseDir,
      input.sourceAgentFolder,
      input.file,
      input.claimedPath,
    );
  }
}

async function denyLockedPermissionInteraction(
  input: Parameters<typeof processPermissionInteractionIpc>[0],
  lockStatus: Exclude<AgentLockStatus, 'full'>,
): Promise<void> {
  input.logger.warn(
    {
      sourceAgentFolder: input.sourceAgentFolder,
      requestId: input.request.requestId,
      toolName: input.request.toolName,
      reason: 'denied_by_profile',
      accessPreset: lockStatus,
    },
    'Denied locked-agent permission IPC at parent boundary',
  );
  try {
    await input.deps.publishRuntimeEvent?.({
      appId: (input.request.appId ?? 'default') as never,
      agentId: (input.request.agentId ??
        memoryAgentIdForWorkspaceFolder(input.sourceAgentFolder)) as never,
      runId: input.request.runId as never,
      jobId: input.request.jobId as never,
      conversationId: input.request.targetJid as never,
      threadId: input.request.threadId as never,
      eventType: RUNTIME_EVENT_TYPES.PERMISSION_DENIED,
      actor: `agent:${input.sourceAgentFolder}`,
      correlationId: input.request.requestId,
      payload: {
        requestId: input.request.requestId,
        toolName: input.request.toolName,
        reasonCode: 'denied_by_profile',
        // 'unknown' marks a fail-closed denial: the settings desired state
        // could not be read at decision time.
        accessPreset: lockStatus,
      },
    });
  } catch (err) {
    input.logger.error(
      {
        err,
        sourceAgentFolder: input.sourceAgentFolder,
        requestId: input.request.requestId,
      },
      'Failed to publish denied_by_profile audit event',
    );
  }
  writePermissionInteractionFailure({
    ipcBaseDir: input.ipcBaseDir,
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.request.requestId,
    responseNonce: input.request.responseNonce,
    threadId: input.request.threadId,
    responseKeyId: input.request.responseKeyId,
    reason:
      lockStatus === 'locked'
        ? 'denied_by_profile: this agent runs with a locked access preset. Permission prompts are disabled; provision the capability before the run.'
        : 'denied_by_profile: agent access preset could not be verified; permission requests fail closed until runtime settings are readable.',
    logger: input.logger,
  });
  archiveIpcErrorFile(
    input.ipcBaseDir,
    input.sourceAgentFolder,
    input.file,
    input.claimedPath,
  );
}

function persistentPermissionScopeRequest(
  request: PermissionApprovalRequest,
): PermissionApprovalRequest {
  if (!request.threadId) return request;
  const { threadId: _routingThreadId, ...parentConversationRequest } = request;
  return parentConversationRequest;
}

function formatPersistentPermissionOutcome(input: {
  rules: string[];
  semanticCapabilityDefinitions?: PermissionApprovalRequest['semanticCapabilityDefinitions'];
  recovery: Awaited<
    ReturnType<typeof recheckSetupPausedJobsAfterCapabilityUpdate>
  >;
}): string {
  const lines = [
    `Allowed for future: ${formatDurableAccessRulesForUser(input.rules, {
      semanticCapabilityDefinitions: input.semanticCapabilityDefinitions,
    })}.`,
  ];
  if (input.recovery.queued.length > 0) {
    lines.push(
      `Job ready: ${input.recovery.queued
        .map((job) => job.name || job.jobId)
        .join(', ')}. It will run now.`,
    );
  }
  if (input.recovery.stillBlocked.length > 0) {
    const blocker = input.recovery.stillBlocked[0];
    lines.push(
      `Still needs setup: ${blocker.nextAction ?? 'review job setup'}.`,
    );
  }
  if (
    input.recovery.checked === 0 &&
    input.recovery.queued.length === 0 &&
    input.recovery.stillBlocked.length === 0
  ) {
    lines.push('No paused setup jobs needed retry.');
  }
  return lines.join('\n');
}

export type PermissionInteractionIpcBatchItem = Parameters<
  typeof processPermissionInteractionIpc
>[0];

export async function processPermissionInteractionIpcBatchWithDecision(input: {
  items: PermissionInteractionIpcBatchItem[];
  decision: PermissionApprovalDecision;
}): Promise<void> {
  for (const item of input.items) {
    await processPermissionInteractionIpc({
      ...item,
      deps: {
        ...item.deps,
        requestPermissionApproval: async () => input.decision,
      },
    });
  }
}

async function sendPermissionOutcomeMessage(
  deps: IpcDeps,
  request: PermissionApprovalRequest,
  input: { text: string },
): Promise<void> {
  if (!request.targetJid) return;
  try {
    await deps.sendMessage(request.targetJid, input.text, {
      ...(request.threadId ? { threadId: request.threadId } : {}),
    });
  } catch {
    // Permission IPC response delivery and events are the authoritative path;
    // user-visible follow-up messages are best effort.
  }
}

async function assertActiveScheduledPermissionLease(input: {
  request: PermissionApprovalRequest;
  sourceAgentFolder: string;
  logger: IpcInteractionLogger;
}): Promise<void> {
  if (!input.request.runId) return;
  const active = await isActiveRunLeaseForInteraction({
    runId: input.request.runId,
    runLeaseToken: input.request.runLeaseToken,
    runLeaseFencingVersion: input.request.runLeaseFencingVersion,
  });
  if (active) return;
  await resolvePendingInteractionRecord({
    kind: 'permission',
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.request.requestId,
    appId: input.request.appId ?? null,
    runId: input.request.runId,
    status: 'cancelled',
    resolution: {
      approved: false,
      reason: 'Run lease is no longer active for this permission request.',
    },
    approverRef: null,
  });
  input.logger.warn(
    {
      requestId: input.request.requestId,
      jobId: input.request.jobId,
      runId: input.request.runId,
      runLeaseFencingVersion: input.request.runLeaseFencingVersion,
    },
    'Rejected scheduled permission IPC because the run lease is no longer active',
  );
  throw new StaleScheduledPermissionLeaseError();
}

async function assertActiveScheduledQuestionLease(input: {
  request: UserQuestionRequest;
  sourceAgentFolder: string;
  logger: IpcInteractionLogger;
}): Promise<void> {
  if (!input.request.runId) return;
  const active = await isActiveRunLeaseForInteraction({
    runId: input.request.runId,
    runLeaseToken: input.request.runLeaseToken,
    runLeaseFencingVersion: input.request.runLeaseFencingVersion,
  });
  if (active) return;
  await resolvePendingInteractionRecord({
    kind: 'question',
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.request.requestId,
    appId: input.request.appId ?? null,
    runId: input.request.runId,
    status: 'cancelled',
    resolution: {
      answers: {},
      reason: 'Run lease is no longer active for this question request.',
    },
    approverRef: null,
  });
  input.logger.warn(
    {
      requestId: input.request.requestId,
      jobId: input.request.jobId,
      runId: input.request.runId,
      runLeaseFencingVersion: input.request.runLeaseFencingVersion,
    },
    'Rejected scheduled user question IPC because the run lease is no longer active',
  );
  throw new StaleScheduledQuestionLeaseError();
}

async function publishPermissionRuntimeEvent(
  deps: IpcDeps,
  request: PermissionApprovalRequest,
  input: {
    eventType: (typeof RUNTIME_EVENT_TYPES)[keyof typeof RUNTIME_EVENT_TYPES];
    payload: Record<string, unknown>;
  },
): Promise<void> {
  if (!deps.publishRuntimeEvent || !request.appId) return;
  try {
    await deps.publishRuntimeEvent({
      appId: request.appId as never,
      agentId: request.agentId as never,
      runId: request.runId as never,
      jobId: request.jobId as never,
      conversationId: request.targetJid as never,
      threadId: request.threadId as never,
      eventType: input.eventType,
      actor: 'permission',
      correlationId: request.requestId,
      payload: input.payload,
    });
  } catch {
    // Runtime-event telemetry is best-effort; permission IPC response delivery
    // must not fail because event persistence is temporarily unavailable.
  }
}

function pathForGroupIpc(
  ipcBaseDir: string,
  sourceAgentFolder: string,
): string {
  return `${ipcBaseDir}/${sourceAgentFolder}`;
}

export async function processUserQuestionInteractionIpc(input: {
  request: UserQuestionRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
  ipcBaseDir: string;
  file: string;
  claimedPath: string;
  logger: IpcInteractionLogger;
}): Promise<void> {
  try {
    const recorded = await recordPendingInteractionRequested({
      kind: 'question',
      sourceAgentFolder: input.sourceAgentFolder,
      requestId: input.request.requestId,
      appId: input.request.appId ?? null,
      runId: input.request.runId ?? null,
      runLeaseToken: input.request.runLeaseToken ?? null,
      runLeaseFencingVersion: input.request.runLeaseFencingVersion ?? null,
      payload: {
        sourceAgentFolder: input.sourceAgentFolder,
        requestId: input.request.requestId,
        questions: input.request.questions.map((question) => question.question),
        targetJid: input.request.targetJid ?? null,
        agentId: input.request.agentId ?? null,
        jobId: input.request.jobId ?? null,
        request: input.request,
      },
      callbackRoute: {
        ipcBaseDir: input.ipcBaseDir,
        targetJid: input.request.targetJid ?? null,
        threadId: input.request.threadId ?? null,
        responseKeyId: input.request.responseKeyId ?? null,
        responsePrivateKeySeal:
          sealIpcResponseSigningPrivateKey(
            getIpcResponseSigningPrivateKey(
              input.sourceAgentFolder,
              input.request.threadId,
              input.request.responseKeyId,
            ),
          ) ?? null,
      },
    });
    if (!recorded) throw new Error('Question prompt was not durably recorded');
    await assertActiveScheduledQuestionLease(input);
    const response = await processUserQuestionIpcRequest(input.request, {
      requestUserAnswer: input.deps.requestUserAnswer,
    });
    await assertActiveScheduledQuestionLease(input);
    const resolved = await resolvePendingInteractionRecord({
      kind: 'question',
      sourceAgentFolder: input.sourceAgentFolder,
      requestId: input.request.requestId,
      appId: input.request.appId ?? null,
      runId: input.request.runId ?? null,
      status: 'resolved',
      resolution: { answers: response.answers || {} },
      approverRef: response.answeredBy ?? null,
    });
    if (!resolved) {
      input.logger.warn(
        {
          sourceAgentFolder: input.sourceAgentFolder,
          requestId: input.request.requestId,
          appId: input.request.appId,
          agentId: input.request.agentId,
          runId: input.request.runId,
          jobId: input.request.jobId,
        },
        'Withholding user question IPC response because durable resolution failed',
      );
      return;
    }
    await assertActiveScheduledQuestionLease(input);
    writeUserQuestionIpcResponse(
      input.ipcBaseDir,
      input.sourceAgentFolder,
      {
        requestId: input.request.requestId,
        answers: response.answers || {},
        answeredBy: response.answeredBy,
      },
      getIpcResponseSigningPrivateKey(
        input.sourceAgentFolder,
        input.request.threadId,
        input.request.responseKeyId,
      ),
    );
    fs.unlinkSync(input.claimedPath);
  } catch (err) {
    if (err instanceof StaleScheduledQuestionLeaseError) {
      archiveIpcErrorFile(
        input.ipcBaseDir,
        input.sourceAgentFolder,
        input.file,
        input.claimedPath,
      );
      return;
    }
    writeUserQuestionInteractionFailure({
      ipcBaseDir: input.ipcBaseDir,
      sourceAgentFolder: input.sourceAgentFolder,
      requestId: input.request.requestId,
      threadId: input.request.threadId,
      responseKeyId: input.request.responseKeyId,
      logger: input.logger,
    });
    input.logger.error(
      { file: input.file, sourceAgentFolder: input.sourceAgentFolder, err },
      'Error processing user question IPC request',
    );
    archiveIpcErrorFile(
      input.ipcBaseDir,
      input.sourceAgentFolder,
      input.file,
      input.claimedPath,
    );
  }
}
