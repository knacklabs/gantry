import { getIpcResponseSigningPrivateKey } from './ipc-auth.js';
import { writePermissionIpcResponse, writeUserQuestionIpcResponse, } from './ipc-interaction-handler.js';
export function writePermissionInteractionFailure(input) {
    try {
        writePermissionIpcResponse(input.ipcBaseDir, input.sourceAgentFolder, {
            requestId: input.requestId,
            ...(input.responseNonce ? { responseNonce: input.responseNonce } : {}),
            approved: false,
            reason: input.reason ?? 'Failed to process permission request',
        }, getIpcResponseSigningPrivateKey(input.sourceAgentFolder, input.threadId, input.responseKeyId));
    }
    catch (err) {
        input.logger.warn({
            sourceAgentFolder: input.sourceAgentFolder,
            requestId: input.requestId,
            err,
        }, 'Failed to write permission IPC denial fallback');
    }
}
export function writeUserQuestionInteractionFailure(input) {
    try {
        writeUserQuestionIpcResponse(input.ipcBaseDir, input.sourceAgentFolder, {
            requestId: input.requestId,
            answers: {},
        }, getIpcResponseSigningPrivateKey(input.sourceAgentFolder, input.threadId, input.responseKeyId));
    }
    catch (err) {
        input.logger.warn({
            sourceAgentFolder: input.sourceAgentFolder,
            requestId: input.requestId,
            err,
        }, 'Failed to write user question IPC fallback response');
    }
}
