import { getIpcResponseSigningPrivateKey } from './ipc-auth.js';
import type { PermissionApprovalRequest } from '../domain/types.js';
import { archiveIpcErrorFile } from './ipc-filesystem.js';
import type { IpcInteractionLogger } from './ipc-interaction-processing.js';
import {
  writePermissionIpcResponse,
  writeUserQuestionIpcResponse,
} from './ipc-interaction-handler.js';

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
