import { recheckSetupPausedJobsAfterCapabilityUpdate } from '../jobs/job-permission-recovery.js';
import { PermissionManagementService } from '../permissions/permission-management-service.js';
function persistentPermissionScopeRequest(request) {
    if (!request.threadId)
        return request;
    const { threadId: _routingThreadId, ...parentConversationRequest } = request;
    return parentConversationRequest;
}
export async function applyRecoveredPersistentPermissionGrant(input) {
    const toolRepository = input.persistence.getToolRepository?.();
    const mirrorAgentToolRulesToSettings = input.persistence.mirrorAgentToolRulesToSettings;
    if (!toolRepository || !mirrorAgentToolRulesToSettings)
        return false;
    const updates = input.decision.updatedPermissions ?? [];
    if (updates.length === 0)
        return false;
    const scopedRequest = persistentPermissionScopeRequest(input.request);
    const permissionService = new PermissionManagementService();
    await permissionService.applyPersistentToolRuleGrant({
        appId: input.request.appId,
        agentId: (input.request.agentId ??
            `agent:${input.sourceAgentFolder}`),
        sourceAgentFolder: input.sourceAgentFolder,
        updates,
        toolRepository,
        mirrorAgentToolRulesToSettings,
        permissionRepository: input.persistence.getPermissionRepository?.(),
        semanticCapabilityDefinitions: input.request.semanticCapabilityDefinitions,
        ipcDir: input.ipcDir,
        runHandle: input.request.runHandle,
        requestId: input.request.requestId,
        actor: input.decision.decidedBy,
        conversationId: scopedRequest.targetJid,
        threadId: scopedRequest.threadId,
        runId: input.request.runId,
        jobId: input.request.jobId,
        reason: input.decision.reason,
    });
    const recovery = await recheckSetupPausedJobsAfterCapabilityUpdate({
        appId: input.request.appId,
        sourceAgentFolder: input.sourceAgentFolder,
        conversationJid: input.request.targetJid,
        jobId: input.request.jobId,
        opsRepository: input.persistence.opsRepository,
        scheduler: {
            requestSchedulerSync: input.persistence.onSchedulerChanged ?? (() => { }),
        },
        toolRepository,
        skillRepository: input.persistence.getSkillRepository?.(),
        mcpServerRepository: input.persistence.getMcpServerRepository?.(),
        capabilitySecretRepository: input.persistence.getCapabilitySecretRepository?.(),
        credentialBroker: await input.persistence.getCredentialBroker?.(),
        getBrowserStatus: input.persistence.getBrowserStatus,
        publishRuntimeEvent: input.persistence.publishRuntimeEvent,
    });
    await input.onApplied?.(recovery);
    return true;
}
