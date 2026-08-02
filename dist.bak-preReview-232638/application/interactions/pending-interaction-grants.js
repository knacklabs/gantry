import { applyRecoveredPersistentPermissionGrant, } from './pending-interaction-permission-recovery.js';
export async function applyPendingInteractionGrantDecision(input, dependencies) {
    if (!input.decision.approved)
        return true;
    if (input.decision.mode === 'allow_persistent_rule' &&
        input.decision.decisionClassification === 'user_permanent') {
        const persistence = input.permissionPersistence ?? dependencies.permissionPersistence;
        if (!input.request || !persistence)
            return false;
        return applyRecoveredPersistentPermissionGrant({
            persistence,
            request: {
                ...input.request,
                requestId: input.requestId,
                sourceAgentFolder: input.sourceAgentFolder,
            },
            sourceAgentFolder: input.sourceAgentFolder,
            decision: input.decision,
            ipcDir: input.ipcDir,
            onApplied: input.onPersistentGrantApplied,
        });
    }
    if (input.decision.decisionClassification === 'user_permanent')
        return true;
    if (!input.runId)
        return true;
    await dependencies.recordRunScopedTransientGrant({
        appId: input.appId,
        runId: input.runId,
        runLeaseToken: input.runLeaseToken,
        runLeaseFencingVersion: input.runLeaseFencingVersion,
        grant: {
            toolName: input.toolName,
            mode: input.decision.mode,
            requestId: input.requestId,
        },
    });
    return true;
}
