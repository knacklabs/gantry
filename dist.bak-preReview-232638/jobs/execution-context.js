import { agentIdForJobWorkspaceKey } from '../application/jobs/job-tool-policy.js';
import { resolveJobNotificationRoutes } from './job-notification-routes.js';
import { buildBoundedMemoryRecallQuery } from '../memory/app-memory-recall-query.js';
import { findConversationRouteForQueue, findSingleConversationRouteForChat, makeAgentThreadQueueKey, } from '../shared/thread-queue-key.js';
export function resolveExecutionContext(job, groups) {
    const executionConversation = normalizeOptional(job.execution_context?.conversationJid);
    if (!executionConversation)
        return null;
    const executionThreadId = normalizeOptional(job.execution_context?.threadId);
    const notificationRoutes = resolveJobNotificationRoutes(job);
    const primaryExecutionRoute = notificationRoutes.find((route) => route.conversationJid === executionConversation &&
        (executionThreadId === undefined ||
            (route.threadId ?? null) === executionThreadId));
    const executionProviderAccountId = normalizeOptional(primaryExecutionRoute?.providerAccountId);
    const executionAgentId = resolveJobExecutionAgentId(job);
    const group = executionAgentId
        ? findConversationRouteForQueue(groups, makeAgentThreadQueueKey(executionConversation, executionAgentId, executionThreadId, executionProviderAccountId), (route) => agentIdForJobWorkspaceKey(route.folder))
        : findSingleConversationRouteForChat(groups, executionConversation, executionThreadId);
    if (!group)
        return null;
    const stopAliasJids = Array.from(new Set([
        executionConversation,
        ...notificationRoutes.map((route) => route.conversationJid),
    ]));
    return {
        group,
        executionJid: executionConversation,
        threadId: executionThreadId ?? primaryExecutionRoute?.threadId ?? null,
        stopAliasJids,
    };
}
export function resolveJobExecutionAgentId(job) {
    const explicitAgentId = normalizeOptional(job.execution_context?.agentId);
    if (explicitAgentId)
        return explicitAgentId;
    const workspaceKey = normalizeOptional(job.execution_context?.workspaceKey) ??
        normalizeOptional(job.workspace_key);
    return workspaceKey ? agentIdForJobWorkspaceKey(workspaceKey) : undefined;
}
export function resolveExecutionMemoryContext(input) {
    if (input.conversationKind === 'dm') {
        return {
            memoryDefaultScope: 'user',
            memoryUserId: input.executionJid,
        };
    }
    return { memoryDefaultScope: 'group' };
}
function normalizeOptional(value) {
    if (typeof value !== 'string')
        return undefined;
    const normalized = value.trim();
    return normalized || undefined;
}
export function buildExecutionTurnContextInput(input) {
    return {
        agentFolder: input.agentFolder,
        executionProviderId: input.executionProviderId,
        conversationJid: input.executionJid,
        threadId: input.threadId ?? null,
        conversationKind: input.conversationKind,
        memoryUserId: input.memoryUserId,
        jobId: input.jobId,
        query: buildBoundedMemoryRecallQuery(input.query),
    };
}
export function parseTriggerRequesterSessionId(requestedBy) {
    try {
        const parsed = JSON.parse(requestedBy);
        if (parsed.kind === 'sdk' &&
            typeof parsed.sessionId === 'string' &&
            parsed.sessionId.trim()) {
            return parsed.sessionId;
        }
    }
    catch {
        // Invalid requestedBy metadata simply means there is no SDK session id.
    }
    return null;
}
