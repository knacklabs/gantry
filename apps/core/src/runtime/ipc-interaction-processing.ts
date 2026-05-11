import fs from 'fs';

import type {
  PermissionApprovalRequest,
  UserQuestionRequest,
} from '../domain/types.js';
import { PermissionManagementService } from '../application/permissions/permission-management-service.js';
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
    const decision = await processPermissionIpcRequest(input.request, {
      requestPermissionApproval: input.deps.requestPermissionApproval,
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
        requestId: input.request.requestId,
        actor: decision.decidedBy,
        conversationId: input.request.targetJid,
        threadId: input.request.threadId,
        reason: decision.reason,
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
      });
    }
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
        updatedPermissions: decision.updatedPermissions,
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
      { file: input.file, sourceAgentFolder: input.sourceAgentFolder, err },
      'Error processing permission IPC request',
    );
    archiveIpcErrorFile(
      input.ipcBaseDir,
      input.sourceAgentFolder,
      input.file,
      input.claimedPath,
    );
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
