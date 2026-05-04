import fs from 'fs';

import type {
  PermissionApprovalRequest,
  UserQuestionRequest,
} from '../domain/types.js';
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
  sourceGroup: string;
  kind: 'permission' | 'user-question';
  threadId?: string;
  requestId: string;
}): string {
  return [
    input.sourceGroup,
    input.kind,
    input.threadId || '',
    input.requestId,
  ].join(':');
}

export function writePermissionInteractionFailure(input: {
  ipcBaseDir: string;
  sourceGroup: string;
  requestId: string;
  responseNonce?: string;
  threadId?: string;
  logger: IpcInteractionLogger;
}): void {
  try {
    writePermissionIpcResponse(
      input.ipcBaseDir,
      input.sourceGroup,
      {
        requestId: input.requestId,
        ...(input.responseNonce ? { responseNonce: input.responseNonce } : {}),
        approved: false,
        reason: 'Failed to process permission request',
      },
      getIpcResponseSigningPrivateKey(input.sourceGroup, input.threadId),
    );
  } catch (err) {
    input.logger.warn(
      { sourceGroup: input.sourceGroup, requestId: input.requestId, err },
      'Failed to write permission IPC denial fallback',
    );
  }
}

export function writeUserQuestionInteractionFailure(input: {
  ipcBaseDir: string;
  sourceGroup: string;
  requestId: string;
  threadId?: string;
  logger: IpcInteractionLogger;
}): void {
  try {
    writeUserQuestionIpcResponse(
      input.ipcBaseDir,
      input.sourceGroup,
      {
        requestId: input.requestId,
        answers: {},
      },
      getIpcResponseSigningPrivateKey(input.sourceGroup, input.threadId),
    );
  } catch (err) {
    input.logger.warn(
      { sourceGroup: input.sourceGroup, requestId: input.requestId, err },
      'Failed to write user question IPC fallback response',
    );
  }
}

export async function processPermissionInteractionIpc(input: {
  request: PermissionApprovalRequest;
  sourceGroup: string;
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
    writePermissionIpcResponse(
      input.ipcBaseDir,
      input.sourceGroup,
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
        input.sourceGroup,
        input.request.threadId,
      ),
    );
    fs.unlinkSync(input.claimedPath);
  } catch (err) {
    writePermissionInteractionFailure({
      ipcBaseDir: input.ipcBaseDir,
      sourceGroup: input.sourceGroup,
      requestId: input.request.requestId,
      responseNonce: input.request.responseNonce,
      threadId: input.request.threadId,
      logger: input.logger,
    });
    input.logger.error(
      { file: input.file, sourceGroup: input.sourceGroup, err },
      'Error processing permission IPC request',
    );
    archiveIpcErrorFile(
      input.ipcBaseDir,
      input.sourceGroup,
      input.file,
      input.claimedPath,
    );
  }
}

export async function processUserQuestionInteractionIpc(input: {
  request: UserQuestionRequest;
  sourceGroup: string;
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
      input.sourceGroup,
      {
        requestId: input.request.requestId,
        answers: response.answers || {},
        answeredBy: response.answeredBy,
      },
      getIpcResponseSigningPrivateKey(
        input.sourceGroup,
        input.request.threadId,
      ),
    );
    fs.unlinkSync(input.claimedPath);
  } catch (err) {
    writeUserQuestionInteractionFailure({
      ipcBaseDir: input.ipcBaseDir,
      sourceGroup: input.sourceGroup,
      requestId: input.request.requestId,
      threadId: input.request.threadId,
      logger: input.logger,
    });
    input.logger.error(
      { file: input.file, sourceGroup: input.sourceGroup, err },
      'Error processing user question IPC request',
    );
    archiveIpcErrorFile(
      input.ipcBaseDir,
      input.sourceGroup,
      input.file,
      input.claimedPath,
    );
  }
}
