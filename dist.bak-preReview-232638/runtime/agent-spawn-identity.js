import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
export function resolveSpawnAgentId(input) {
    return (input.inputAgentId ??
        input.routeAgentId ??
        memoryAgentIdForWorkspaceFolder(input.workspaceFolder));
}
export function resolveAgentSpawnLogContext(group, input, correlationRunId) {
    const appId = input.appId ?? 'default';
    const agentId = resolveSpawnAgentId({
        inputAgentId: input.agentId,
        routeAgentId: group.agentId,
        workspaceFolder: group.folder,
    });
    return {
        agentName: group.name,
        turn: { ...input, appId, agentId },
        correlationRunId: input.runId ?? correlationRunId,
        appId,
        agentId,
    };
}
export function stripIncompleteRunLeaseIdentity(input) {
    const hasRunId = Boolean(input.runId);
    const hasLeaseToken = Boolean(input.runLeaseToken);
    const hasFencingVersion = typeof input.runLeaseFencingVersion === 'number';
    if (hasRunId && hasLeaseToken && hasFencingVersion)
        return input;
    if (!hasRunId && !hasLeaseToken && !hasFencingVersion)
        return input;
    const { runId: _runId, runLeaseToken: _runLeaseToken, runLeaseFencingVersion: _runLeaseFencingVersion, ...correlationOnlyInput } = input;
    return correlationOnlyInput;
}
