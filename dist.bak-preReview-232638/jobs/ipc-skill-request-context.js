import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { toTrimmedString } from './ipc-shared.js';
export function resolveTaskAgentId(data, sourceAgentFolder) {
    return (toTrimmedString(data.agentId, { maxLen: 512 }) ||
        memoryAgentIdForWorkspaceFolder(sourceAgentFolder));
}
export function validateSameChannelApprovalTarget(input) {
    const requestedTargetJid = toTrimmedString(input.data.chatJid, {
        maxLen: 512,
    });
    const targetOverride = toTrimmedString(input.data.targetJid || input.data.jid, {
        maxLen: 512,
    });
    if (targetOverride && targetOverride !== requestedTargetJid) {
        input.reject(`${input.requestKind} requests must use the originating chat as the approval target.`, 'forbidden');
        return null;
    }
    if (!requestedTargetJid ||
        !input.sourceAgentFolderJids.includes(requestedTargetJid)) {
        input.reject(`${input.requestKind} requests must include the originating chat for this agent.`, 'forbidden');
        return null;
    }
    return requestedTargetJid;
}
