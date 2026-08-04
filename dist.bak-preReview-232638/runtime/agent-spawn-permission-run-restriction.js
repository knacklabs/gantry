import { createIpcAuthEnvelope } from './ipc-auth.js';
import { registerPermissionRunRestriction, unregisterPermissionRunRestriction, } from './permission-decision-coordinator.js';
export function registerWorkerPermissionRunRestriction(input) {
    registerPermissionRunRestriction(input);
}
export function setupPermissionRunRestriction(sourceAgentFolder, agentInput, hideAuthorityTools) {
    const ipcAuth = createIpcAuthEnvelope(sourceAgentFolder, agentInput.threadId, {
        appId: agentInput.appId || 'default',
        agentId: agentInput.agentId,
    });
    registerWorkerPermissionRunRestriction({
        sourceAgentFolder,
        responseKeyId: ipcAuth.responseKeyId,
        hideAuthorityTools,
    });
    return {
        ipcAuth,
        unregisterPermissionRunRestriction: () => unregisterPermissionRunRestriction({
            sourceAgentFolder,
            responseKeyId: ipcAuth.responseKeyId,
        }),
    };
}
