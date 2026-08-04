import { conversationBoundAgentIdsForRoute, projectCallableAgentTools, } from '../../application/core-tools/callable-agent-tools.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
export async function resolveInlineCallableAgentManifest(laneInput, repository, configuredAgents, conversationRoutes = {}, toolsAvailable = true, warn) {
    const run = laneInput.input;
    const delegates = configuredAgents?.[laneInput.group.folder]?.delegates ?? [];
    if (!toolsAvailable ||
        run.disableTools === true ||
        run.hideAuthorityTools === true ||
        !repository ||
        !run.appId ||
        !run.agentId ||
        run.parentTaskId != null ||
        !run.toolPolicyRules?.includes('AgentDelegation') ||
        delegates.length === 0) {
        return [];
    }
    const agents = await repository.listAgents(run.appId);
    const conversationBoundAgentIds = conversationBoundAgentIdsForRoute({
        routes: conversationRoutes,
        chatJid: run.chatJid,
        threadId: run.threadId,
        callerAgentId: run.agentId,
        callerProviderAccountId: laneInput.group.providerAccountId,
    });
    const personasByAgentId = Object.fromEntries(Object.entries(configuredAgents ?? {}).flatMap(([folder, configured]) => configured
        ? [[String(agentIdForFolder(folder)), configured.persona]]
        : []));
    return projectCallableAgentTools({
        agents,
        callerAppId: run.appId,
        callerAgentId: run.agentId,
        callerFolder: laneInput.group.folder,
        delegates,
        conversationBoundAgentIds,
        personasByAgentId,
        toolPolicyRules: run.toolPolicyRules,
        parentTaskId: run.parentTaskId,
        warn,
    });
}
