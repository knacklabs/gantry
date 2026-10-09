import { getIpcResponseSigningPrivateKey } from './ipc-auth.js';
import type { PermissionApprovalRequest } from '../domain/types.js';
import { archiveIpcErrorFile } from './ipc-filesystem.js';
import type {
  IpcInteractionLogger,
  processPermissionInteractionIpc,
} from './ipc-interaction-processing.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import {
  writePermissionIpcResponse,
  writeUserQuestionIpcResponse,
} from './ipc-interaction-handler.js';

export async function denyLockedPermissionInteraction(
  input: Parameters<typeof processPermissionInteractionIpc>[0],
  lockStatus: 'locked' | 'unknown',
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
      actor: { kind: 'system', source: `agent:${input.sourceAgentFolder}` },
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
  refusePermissionInteraction(
    input,
    lockStatus === 'locked'
      ? 'denied_by_profile: this agent runs with a locked access preset. Permission prompts are disabled; provision the capability before the run.'
      : 'denied_by_profile: agent access preset could not be verified; permission requests fail closed until runtime settings are readable.',
  );
}

export function refusePermissionInteraction(
  input: {
    ipcBaseDir: string;
    sourceAgentFolder: string;
    request: Pick<
      PermissionApprovalRequest,
      'requestId' | 'responseNonce' | 'threadId' | 'responseKeyId'
    >;
    file: string;
    claimedPath: string;
    logger: IpcInteractionLogger;
  },
  reason: string,
): void {
  writePermissionInteractionFailure({ ...input.request, ...input, reason });
  archiveIpcErrorFile(
    input.ipcBaseDir,
    input.sourceAgentFolder,
    input.file,
    input.claimedPath,
  );
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
