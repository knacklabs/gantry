export function durablePermissionRequestSnapshot(request) {
    return {
        requestId: request.requestId,
        appId: request.appId,
        agentId: request.agentId,
        providerAccountId: request.providerAccountId,
        sourceAgentFolder: request.sourceAgentFolder,
        runHandle: request.runHandle,
        jobId: request.jobId,
        runId: request.runId,
        targetJid: request.targetJid,
        approvalContextJid: request.approvalContextJid,
        threadId: request.threadId,
        toolName: request.toolName,
        toolInputSanitized: request.toolInputSanitized,
        toolInputSanitizedPaths: request.toolInputSanitizedPaths,
        suggestions: request.suggestions,
        decisionOptions: request.decisionOptions,
        decisionPolicy: request.decisionPolicy,
        semanticCapabilityDefinitions: request.semanticCapabilityDefinitions,
        permissionBatch: request.permissionBatch,
    };
}
export function readDurablePermissionFullView(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const candidate = value;
    const label = durablePermissionFullViewString(candidate.label);
    const title = durablePermissionFullViewString(candidate.title);
    const filename = durablePermissionFullViewString(candidate.filename);
    const content = durablePermissionFullViewString(candidate.content);
    if (!label || !title || !filename || !content)
        return undefined;
    return { label, title, filename, content };
}
export function permissionRequestFromPayload(payload) {
    return isPermissionRequest(payload.request) ? payload.request : null;
}
export function isStringOrNull(value) {
    return value === null || typeof value === 'string';
}
function durablePermissionFullViewString(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function isPermissionRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const request = value;
    return (typeof request.requestId === 'string' &&
        typeof request.sourceAgentFolder === 'string' &&
        typeof request.toolName === 'string');
}
