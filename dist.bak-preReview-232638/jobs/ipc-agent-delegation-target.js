import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import { logger } from '../infrastructure/logging/logger.js';
import { resolveRunnerIpcRoute } from '../runtime/ipc-route-authorization.js';
import { resolveTurnSelectedMcpServerIds, resolveTurnSelectedSkillContext, resolveTurnSemanticCapabilities, resolveTurnToolPolicy, } from '../runtime/group-run-context.js';
import { CALLABLE_AGENT_SYNC_WAIT_MAX_MS } from '../application/core-tools/callable-agent-tools.js';
import { callableAgentToolName, projectCallableAgentTools, } from '../application/core-tools/callable-agent-tools.js';
import { findConversationRouteForQueue, makeAgentThreadQueueKey, routesForConversationId, } from '../shared/thread-queue-key.js';
export function resolveDelegatedAgentTimeouts(payload, executionTimeoutMaxMs) {
    return {
        timeoutMs: typeof payload.timeoutMs === 'number'
            ? Math.min(payload.timeoutMs, executionTimeoutMaxMs)
            : undefined,
        syncWaitTimeoutMs: typeof payload.syncWaitTimeoutMs === 'number'
            ? Math.min(payload.syncWaitTimeoutMs, CALLABLE_AGENT_SYNC_WAIT_MAX_MS)
            : undefined,
    };
}
export async function resolveDelegatedAgentTarget(input) {
    let callerRoute;
    try {
        callerRoute = resolveRunnerIpcRoute({
            routes: input.routes,
            sourceAgentFolder: input.sourceAgentFolder,
            targetJid: input.owner.conversationId,
            threadId: input.owner.threadId ?? undefined,
            providerAccountId: input.trustedProviderAccountId ?? undefined,
        });
    }
    catch {
        return {
            ok: false,
            message: 'Delegated task conversation route is ambiguous or unauthorized.',
            code: 'forbidden',
        };
    }
    if (input.requestedProviderAccountId &&
        input.requestedProviderAccountId !== callerRoute.providerAccountId) {
        return {
            ok: false,
            message: 'Delegated task provider account does not match the caller route.',
            code: 'forbidden',
        };
    }
    const selectedAgentId = input.targetAgentId ?? input.owner.agentId;
    const targetRoutes = selectedAgentId === input.owner.agentId
        ? input.routes
        : routesForConversationId(input.routes, callerRoute.conversationId);
    const group = findConversationRouteForQueue(targetRoutes, makeAgentThreadQueueKey(input.owner.conversationId, selectedAgentId, input.owner.threadId, selectedAgentId === input.owner.agentId
        ? callerRoute.providerAccountId
        : undefined), (route) => route.agentId ?? agentIdForFolder(route.folder));
    if (!group) {
        return {
            ok: false,
            message: input.targetAgentId
                ? `Target agent is not bound to this conversation: ${input.targetAgentId}`
                : 'Delegated task conversation is unavailable.',
            code: 'not_found',
        };
    }
    const callerToolPolicy = await resolveTurnToolPolicy(input.deps, input.owner);
    if (!callerToolPolicy.toolPolicyRules?.includes('AgentDelegation')) {
        return {
            ok: false,
            message: 'delegate_task requires AgentDelegation access.',
            code: 'forbidden',
        };
    }
    const syntheticToolName = typeof input.callableAgentToolName === 'string'
        ? input.callableAgentToolName.trim()
        : '';
    const targetAgentId = group.agentId ?? agentIdForFolder(group.folder);
    let callableAgentEntry;
    if (targetAgentId !== input.owner.agentId || syntheticToolName) {
        const permittedEntry = await findCallableAgentEntry({
            deps: input.deps,
            owner: input.owner,
            sourceAgentFolder: input.sourceAgentFolder,
            toolPolicyRules: callerToolPolicy.toolPolicyRules,
            syntheticToolName,
            targetAgentId,
        });
        if (!permittedEntry) {
            return {
                ok: false,
                message: 'Callable agent target is no longer permitted.',
                code: 'forbidden',
            };
        }
        if (syntheticToolName)
            callableAgentEntry = permittedEntry;
    }
    const targetOwner = { ...input.owner, agentId: targetAgentId };
    const [toolPolicy, selectedSkillContext, semanticCapabilities] = await Promise.all([
        targetAgentId === input.owner.agentId
            ? Promise.resolve(callerToolPolicy)
            : resolveTurnToolPolicy(input.deps, targetOwner),
        resolveTurnSelectedSkillContext(input.deps, targetOwner),
        resolveTurnSemanticCapabilities(input.deps, targetOwner),
    ]);
    const attachedMcpSourceIds = await resolveTurnSelectedMcpServerIds(input.deps, targetOwner);
    return {
        ok: true,
        group,
        targetAgentId,
        targetOwner,
        toolPolicy,
        selectedSkillContext,
        semanticCapabilities,
        attachedMcpSourceIds,
        callableAgentEntry,
        providerAccountId: callerRoute.providerAccountId ?? null,
    };
}
async function findCallableAgentEntry(input) {
    const repository = input.deps.getAgentRepository?.();
    const configuredAgents = input.deps.getPermissionRuntimeSettings?.()?.agents ?? {};
    const delegates = configuredAgents[input.sourceAgentFolder]?.delegates ?? [];
    if (!repository || delegates.length === 0) {
        return undefined;
    }
    const manifest = projectCallableAgentTools({
        agents: await repository.listAgents(input.owner.appId),
        callerAppId: input.owner.appId,
        callerAgentId: input.owner.agentId,
        callerFolder: input.sourceAgentFolder,
        delegates,
        conversationBoundAgentIds: new Set([input.targetAgentId]),
        personasByAgentId: Object.fromEntries(Object.entries(configuredAgents).flatMap(([folder, configured]) => configured
            ? [[String(agentIdForFolder(folder)), configured.persona]]
            : [])),
        toolPolicyRules: input.toolPolicyRules,
        warn: logger.warn.bind(logger),
    });
    return manifest.find((entry) => entry.targetAgentId === input.targetAgentId &&
        (!input.syntheticToolName ||
            callableAgentToolName(entry) === input.syntheticToolName));
}
