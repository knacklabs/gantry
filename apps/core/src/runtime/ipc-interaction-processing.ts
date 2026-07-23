import fs from 'fs';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { PermissionManagementService } from '../application/permissions/permission-management-service.js';
import type { PausedJobCapabilityRecheckResult } from '../application/jobs/job-permission-recovery.js';
import { formatDurableAccessRuleForEvent } from '../shared/durable-access-policy.js';
import {
  permissionUpdateAllowedToolRules,
  persistentPermissionUpdates,
} from '../shared/permission-tool-rules.js';
import { redactSensitiveText } from '../shared/sensitive-material.js';
import { incrementOperationalError } from '../shared/operational-error-counters.js';
import { archiveIpcErrorFile } from './ipc-filesystem.js';
import {
  getIpcResponseSigningPrivateKey,
  sealIpcResponseSigningPrivateKey,
} from './ipc-auth.js';
import {
  applyPermissionInteractionDecision,
  DurableInteractionPersistenceError,
  isActiveRunLeaseForInteraction,
  releasePermissionInteractionCallback,
  replayPersistedPermissionDecisionForRequest,
  resolvePendingInteractionRecord,
} from '../application/interactions/pending-interaction-durability.js';
import {
  beginDurablePermissionInteraction,
  beginDurableQuestionInteraction,
  durablePermissionRequestSnapshot,
  finishDurableQuestionInteraction,
  resolveDurablePermissionInteractionOutcome,
} from '../application/interactions/durable-interaction-handler.js';
import {
  resolveAgentLockStatus,
  type AgentLockStatus,
} from '../config/profiles.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { ParsedPermissionIpcRequest } from './ipc-parsing.js';
import {
  processUserQuestionIpcRequest,
  writePermissionIpcResponse,
  writeUserQuestionIpcResponse,
} from './ipc-interaction-handler.js';
import {
  writePermissionInteractionFailure,
  writeUserQuestionInteractionFailure,
} from './ipc-interaction-failure.js';
import { resolvePermissionIpcDecision } from './ipc-permission-classifier-decision.js';
import { recordHumanPermissionPromotionSignal } from './permission-classifier.js';
import { synthesizeHostPermissionSuggestions } from '../application/permissions/permission-suggestion-synthesis.js';
import {
  permissionDecisionEventType,
  permissionDecisionName,
  permissionTelemetryContext,
} from './ipc-permission-telemetry.js';
import {
  publishPendingInteractionRuntimeEvent,
  publishPermissionRuntimeEvent,
} from './ipc-interaction-runtime-events.js';

export { publishPendingInteractionRuntimeEvent };
export {
  writePermissionInteractionFailure,
  writeUserQuestionInteractionFailure,
} from './ipc-interaction-failure.js';

type LogContext = Record<string, unknown>;
export type IpcInteractionLogger = {
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
  kind: 'permission' | 'rich-interaction' | 'user-question';
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

export async function processPermissionInteractionIpc(input: {
  request: ParsedPermissionIpcRequest;
  sourceAgentFolder: string;
  deps: IpcDeps;
  ipcBaseDir: string;
  file: string;
  claimedPath: string;
  logger: IpcInteractionLogger;
}): Promise<void> {
  let decision: PermissionApprovalDecision | undefined;
  let authorityApplicationStarted = false;
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
  input.request.suggestions ??= synthesizeHostPermissionSuggestions(
    input.request.toolName,
    input.request.toolInput,
  );
  try {
    const requestedContext = permissionTelemetryContext(input.request, {
      sourceAgentFolder: input.sourceAgentFolder,
      decision: 'requested',
    });
    input.logger.info?.(requestedContext, 'Permission requested');
    // Durable pending record first: the prompt may only render once the
    // interaction can survive a provider/control-plane restart.
    await beginDurablePermissionInteraction({
      request: input.request,
      sourceAgentFolder: input.sourceAgentFolder,
      payload: {
        ...requestedContext,
        decisionPolicy: input.request.decisionPolicy ?? null,
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
    await publishPendingInteractionRuntimeEvent(
      input.deps,
      input.request,
      'permission',
      input.sourceAgentFolder,
    );
    await publishPermissionRuntimeEvent(input.deps, input.request, {
      eventType: RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
      payload: requestedContext,
    });
    await assertActiveScheduledPermissionLease(input);
    decision =
      (await replayPersistedPermissionDecisionForRequest({
        appId: input.request.appId,
        sourceAgentFolder: input.sourceAgentFolder,
        requestId: input.request.requestId,
      })) ??
      (await resolvePermissionIpcDecision({
        request: input.request,
        sourceAgentFolder: input.sourceAgentFolder,
        deps: input.deps,
      }));
    const claimedDecision = decision;
    await assertActiveScheduledPermissionLease(input);
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
    await assertActiveScheduledPermissionLease(input);
    authorityApplicationStarted = true;
    const applied = await applyPermissionInteractionDecision({
      request: input.request,
      sourceAgentFolder: input.sourceAgentFolder,
      decision,
      appId: input.request.appId,
      runId: input.request.runId,
      runLeaseToken: input.request.runLeaseToken,
      runLeaseFencingVersion: input.request.runLeaseFencingVersion,
      toolName: input.request.toolName,
      requestId: input.request.requestId,
      ipcDir: pathForGroupIpc(input.ipcBaseDir, input.sourceAgentFolder),
      permissionPersistence: {
        opsRepository: input.deps.opsRepository,
        getToolRepository: input.deps.getToolRepository,
        getPermissionRepository: input.deps.getPermissionRepository,
        mirrorAgentToolRulesToSettings:
          input.deps.mirrorAgentToolRulesToSettings,
        onSchedulerChanged: input.deps.onSchedulerChanged,
        getSkillRepository: input.deps.getSkillRepository,
        getMcpServerRepository: input.deps.getMcpServerRepository,
        getCapabilitySecretRepository: input.deps.getCapabilitySecretRepository,
        getCredentialBroker: input.deps.getCredentialBroker,
        getBrowserStatus: input.deps.getBrowserStatus,
        publishRuntimeEvent: input.deps.publishRuntimeEvent,
      },
      onPersistentGrantApplied: async (recovery) => {
        const persistentScopeRequest = persistentPermissionScopeRequest(
          input.request,
        );
        const persistedContext = permissionTelemetryContext(
          persistentScopeRequest,
          {
            sourceAgentFolder: input.sourceAgentFolder,
            decision: 'persisted',
            persistedRules: permissionUpdateAllowedToolRules(
              claimedDecision.updatedPermissions,
            ).map(formatDurableAccessRuleForEvent),
          },
        );
        input.logger.info?.(persistedContext, 'Permission persisted');
        await publishPermissionRuntimeEvent(
          input.deps,
          persistentScopeRequest,
          {
            eventType: RUNTIME_EVENT_TYPES.PERMISSION_PERSISTED,
            payload: persistedContext,
          },
        );
        const outcomeMessage = formatPersistentPermissionOutcome(recovery);
        if (outcomeMessage) {
          await sendPermissionOutcomeMessage(input.deps, input.request, {
            text: outcomeMessage,
          });
        }
      },
    });
    if (!applied) {
      await releasePermissionDecisionClaim(decision);
      input.logger.warn(
        decisionContext,
        'Withholding permission IPC response because grant application failed',
      );
      return;
    }
    recordHumanPermissionPromotionSignal({
      repository: input.deps.getPermissionPromotionRepository?.(),
      appId: input.request.appId,
      agentFolder: input.sourceAgentFolder,
      request: input.request,
      decision,
    });
    const permissionService = new PermissionManagementService();
    if (
      decision.mode !== 'allow_persistent_rule' ||
      decision.decisionClassification !== 'user_permanent'
    ) {
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
    const resolveInput = {
      request: input.request,
      sourceAgentFolder: input.sourceAgentFolder,
      decision,
      updatedPermissions: responsePermissionUpdates,
    };
    let resolutionOutcome =
      await resolveDurablePermissionInteractionOutcome(resolveInput);
    if (resolutionOutcome === 'retryable_error') {
      input.logger.warn(
        permissionTelemetryContext(input.request, {
          sourceAgentFolder: input.sourceAgentFolder,
          decision: permissionDecisionName(decision),
        }),
        'Retrying durable permission resolution after a transient failure',
      );
      await assertActiveScheduledPermissionLease(input);
      resolutionOutcome =
        await resolveDurablePermissionInteractionOutcome(resolveInput);
    }
    if (resolutionOutcome !== 'resolved') {
      incrementOperationalError('interaction', 'permission_request');
      input.logger.warn(
        permissionTelemetryContext(input.request, {
          sourceAgentFolder: input.sourceAgentFolder,
          decision: permissionDecisionName(decision),
          resolutionOutcome,
        }),
        'Withholding permission IPC response because durable resolution failed',
      );
      archiveIpcErrorFile(
        input.ipcBaseDir,
        input.sourceAgentFolder,
        input.file,
        input.claimedPath,
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
      },
      getIpcResponseSigningPrivateKey(
        input.sourceAgentFolder,
        input.request.threadId,
        input.request.responseKeyId,
      ),
    );
    fs.unlinkSync(input.claimedPath);
  } catch (err) {
    if (!authorityApplicationStarted) {
      await releasePermissionDecisionClaim(decision);
    }
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
    if (err instanceof DurableInteractionPersistenceError) {
      input.logger.error(
        { file: input.file, sourceAgentFolder: input.sourceAgentFolder, err },
        'Withholding permission IPC response after durable persistence failure',
      );
      archiveIpcErrorFile(
        input.ipcBaseDir,
        input.sourceAgentFolder,
        input.file,
        input.claimedPath,
      );
      return;
    }
    incrementOperationalError('interaction', 'permission_request');
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

async function releasePermissionDecisionClaim(
  decision: PermissionApprovalDecision | undefined,
): Promise<void> {
  if (!decision?.permissionCallbackClaim) return;
  await releasePermissionInteractionCallback({
    claim: decision.permissionCallbackClaim,
  });
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

function formatPersistentPermissionOutcome(
  recovery: PausedJobCapabilityRecheckResult,
): string | undefined {
  const blocker = recovery.stillBlocked[0];
  if (!blocker) return undefined;
  const nextAction = blocker.nextAction ?? 'review job setup';
  const punctuation = /[.!?]$/.test(nextAction) ? '' : '.';
  return `Still needs setup: ${nextAction}${punctuation}`;
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
    const began = await beginDurableQuestionInteraction({
      request: input.request,
      sourceAgentFolder: input.sourceAgentFolder,
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
    if (!began) {
      input.logger.warn(
        {
          requestId: input.request.requestId,
          sourceAgentFolder: input.sourceAgentFolder,
        },
        'Withholding orphaned user question IPC after restart',
      );
      archiveIpcErrorFile(
        input.ipcBaseDir,
        input.sourceAgentFolder,
        input.file,
        input.claimedPath,
      );
      return;
    }
    const request = input.request;
    const processingInput = { ...input, request };
    await publishPendingInteractionRuntimeEvent(
      input.deps,
      request,
      'question',
      input.sourceAgentFolder,
    );
    await assertActiveScheduledQuestionLease(processingInput);
    const promptedResponse = await processUserQuestionIpcRequest(request, {
      requestUserAnswer: input.deps.requestUserAnswer,
    });
    const response: UserQuestionResponse = {
      requestId: request.requestId,
      answers: promptedResponse.answers,
      ...(promptedResponse.answeredBy
        ? { answeredBy: promptedResponse.answeredBy }
        : {}),
    };
    await assertActiveScheduledQuestionLease(processingInput);
    const resolved = await finishDurableQuestionInteraction({
      request,
      sourceAgentFolder: input.sourceAgentFolder,
      response,
    });
    if (!resolved) {
      incrementOperationalError('interaction', 'user_question_request');
      input.logger.warn(
        {
          sourceAgentFolder: input.sourceAgentFolder,
          requestId: request.requestId,
          appId: request.appId,
          agentId: request.agentId,
          runId: request.runId,
          jobId: request.jobId,
        },
        'Withholding user question IPC response because durable resolution failed',
      );
      return;
    }
    await assertActiveScheduledQuestionLease(processingInput);
    writeUserQuestionIpcResponse(
      input.ipcBaseDir,
      input.sourceAgentFolder,
      {
        requestId: request.requestId,
        answers: response.answers || {},
        answeredBy: response.answeredBy,
      },
      getIpcResponseSigningPrivateKey(
        input.sourceAgentFolder,
        request.threadId,
        request.responseKeyId,
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
    if (err instanceof DurableInteractionPersistenceError) {
      input.logger.error(
        { file: input.file, sourceAgentFolder: input.sourceAgentFolder, err },
        'Withholding user question IPC response after durable persistence failure',
      );
      archiveIpcErrorFile(
        input.ipcBaseDir,
        input.sourceAgentFolder,
        input.file,
        input.claimedPath,
      );
      return;
    }
    incrementOperationalError('interaction', 'user_question_request');
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
