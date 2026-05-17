import fs from 'fs';
import { createHash } from 'node:crypto';

import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
} from '../domain/types.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { PermissionManagementService } from '../application/permissions/permission-management-service.js';
import {
  formatPersistentPermissionRuleForEvent,
  formatPersistentPermissionRulesForUser,
} from '../shared/persistent-permission-rules.js';
import {
  permissionUpdateAllowedToolRules,
  persistentPermissionUpdates,
} from '../shared/permission-tool-rules.js';
import { redactSensitiveText } from '../shared/sensitive-material.js';
import { archiveIpcErrorFile } from './ipc-filesystem.js';
import { getIpcResponseSigningPrivateKey } from './ipc-auth.js';
import type { IpcDeps } from './ipc-domain-types.js';
import {
  processPermissionIpcRequest,
  processUserQuestionIpcRequest,
  writePermissionIpcResponse,
  writeUserQuestionIpcResponse,
} from './ipc-interaction-handler.js';

type LogContext = Record<string, unknown>;
type IpcInteractionLogger = {
  info?(context: LogContext, message: string): void;
  warn(context: LogContext, message: string): void;
  error(context: LogContext, message: string): void;
};

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
        reason: 'Failed to process permission request',
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
  try {
    const requestedContext = permissionTelemetryContext(input.request, {
      sourceAgentFolder: input.sourceAgentFolder,
      decision: 'requested',
    });
    input.logger.info?.(requestedContext, 'Permission requested');
    await publishPermissionRuntimeEvent(input.deps, input.request, {
      eventType: RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
      payload: requestedContext,
    });
    const decision = await processPermissionIpcRequest(input.request, {
      requestPermissionApproval: input.deps.requestPermissionApproval,
    });
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
        mirrorAgentToolRulesToSettings,
        permissionRepository: input.deps.getPermissionRepository?.(),
        ipcDir: pathForGroupIpc(input.ipcBaseDir, input.sourceAgentFolder),
        runHandle: input.request.runHandle,
        requestId: input.request.requestId,
        actor: decision.decidedBy,
        conversationId: input.request.targetJid,
        threadId: input.request.threadId,
        runId: input.request.runId,
        jobId: input.request.jobId,
        reason: decision.reason,
      });
      const persistedContext = permissionTelemetryContext(input.request, {
        sourceAgentFolder: input.sourceAgentFolder,
        decision: 'persisted',
        persistedRules: permissionUpdateAllowedToolRules(
          decision.updatedPermissions,
        ).map(formatPersistentPermissionRuleForEvent),
      });
      input.logger.info?.(persistedContext, 'Permission persisted');
      await publishPermissionRuntimeEvent(input.deps, input.request, {
        eventType: RUNTIME_EVENT_TYPES.PERMISSION_PERSISTED,
        payload: persistedContext,
      });
      await sendPermissionOutcomeMessage(input.deps, input.request, {
        text: `Always allowed: ${formatPersistentPermissionRulesForUser(permissionUpdateAllowedToolRules(decision.updatedPermissions))}.`,
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

function permissionDecisionName(
  decision: PermissionApprovalDecision,
): 'allowed' | 'cancelled' | 'denied' {
  if (decision.approved) return 'allowed';
  return decision.mode === 'cancel' ? 'cancelled' : 'denied';
}

function permissionDecisionEventType(decision: PermissionApprovalDecision) {
  if (decision.approved) return RUNTIME_EVENT_TYPES.PERMISSION_ALLOWED;
  return decision.mode === 'cancel'
    ? RUNTIME_EVENT_TYPES.PERMISSION_CANCELLED
    : RUNTIME_EVENT_TYPES.PERMISSION_DENIED;
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

function permissionTelemetryContext(
  request: PermissionApprovalRequest,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const command = permissionCommand(request);
  return {
    appId: request.appId,
    agentId: request.agentId,
    runId: request.runId,
    jobId: request.jobId,
    conversationId: request.targetJid,
    threadId: request.threadId,
    requestId: request.requestId,
    toolName: request.toolName,
    canonicalCapability: permissionCanonicalCapability(request),
    ...safeCommandTelemetry(command),
    ...extra,
  };
}

function permissionCanonicalCapability(
  request: PermissionApprovalRequest,
): string {
  const capabilityId = request.interaction?.requestContext?.capabilityId;
  if (capabilityId) return capabilityId;
  const toolInputCapabilityId = request.toolInput?.capabilityId;
  if (typeof toolInputCapabilityId === 'string' && toolInputCapabilityId) {
    return toolInputCapabilityId;
  }
  return request.toolName;
}

function permissionCommand(request: PermissionApprovalRequest): string | null {
  if (request.toolName !== 'Bash') return null;
  const command = request.toolInput?.command ?? request.toolInput?.cmd;
  return typeof command === 'string' && command.trim() ? command.trim() : null;
}

function safeCommandTelemetry(command: string | null): Record<string, unknown> {
  if (!command) return {};
  return {
    commandPreview: redactSensitiveText(command).slice(0, 160),
    commandHash: createHash('sha256').update(command).digest('hex'),
  };
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
    const response = await processUserQuestionIpcRequest(input.request, {
      requestUserAnswer: input.deps.requestUserAnswer,
    });
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
