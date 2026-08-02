import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { folderForAgentId } from '../../../domain/agent/agent-folder-id.js';
import { makeAgentThreadQueueKey } from '../../../shared/thread-queue-key.js';
import { getProvider } from '../../../channels/provider-registry.js';
export async function projectConversationInstallToRuntime(ctx, install) {
    if (install.status !== 'active') {
        await removeConversationInstallFromRuntime(ctx, install);
        return;
    }
    const projectRoute = ctx.app
        .projectConversationRoute;
    if (typeof projectRoute !== 'function')
        return;
    const repositories = getRuntimeStorage().repositories;
    const [agent, conversation] = await Promise.all([
        repositories.agents.getAgent(install.agentId),
        repositories.conversations.getConversation(install.conversationId),
    ]);
    if (!agent || !conversation)
        return;
    const externalThreadId = await externalThreadIdForInstall(install.threadId, conversation);
    if (externalThreadId === null)
        return;
    const providerAccount = await repositories.providerAccounts.getProviderAccount(install.providerAccountId);
    if (!providerAccount || providerAccount.status !== 'active')
        return;
    const externalConversationId = conversation.externalRef?.value?.trim();
    if (!externalConversationId)
        return;
    const jid = jidForConversation(String(providerAccount.providerId), externalConversationId);
    await projectRoute.call(ctx.app, externalThreadId
        ? makeAgentThreadQueueKey(jid, undefined, externalThreadId)
        : jid, routeStateForConversationInstall({ agent, install, conversation }));
}
export async function removeProviderAccountRoutesFromRuntime(ctx, providerAccountId) {
    const getRoutes = ctx.app
        .getConversationRoutes;
    const removeRoute = ctx.app
        .unregisterConversationRoute;
    if (typeof getRoutes !== 'function' || typeof removeRoute !== 'function') {
        return;
    }
    const routes = getRoutes.call(ctx.app);
    const routeKeys = Object.entries(routes)
        .filter(([, route]) => route.providerAccountId === providerAccountId)
        .map(([routeKey]) => routeKey);
    for (const routeKey of routeKeys) {
        await removeRoute.call(ctx.app, routeKey);
    }
}
export async function projectProviderAccountRoutesToRuntime(ctx, providerAccountId) {
    const repositories = getRuntimeStorage().repositories;
    const providerAccount = await repositories.providerAccounts.getProviderAccount(providerAccountId);
    if (!providerAccount || providerAccount.status !== 'active')
        return;
    const installs = await repositories.providerAccounts.listConversationInstalls(providerAccount.appId, providerAccount.agentId);
    for (const install of installs) {
        if (install.providerAccountId === providerAccountId) {
            await projectConversationInstallToRuntime(ctx, install);
        }
    }
}
export async function removeConversationInstallFromRuntime(ctx, install) {
    const removeRoute = ctx.app
        .unregisterConversationRoute;
    if (typeof removeRoute !== 'function')
        return;
    const repositories = getRuntimeStorage().repositories;
    const conversation = await repositories.conversations.getConversation(install.conversationId);
    if (!conversation)
        return;
    const externalThreadId = await externalThreadIdForInstall(install.threadId, conversation);
    if (externalThreadId === null)
        return;
    const providerAccount = await repositories.providerAccounts.getProviderAccount(install.providerAccountId);
    if (!providerAccount)
        return;
    const externalConversationId = conversation.externalRef?.value?.trim();
    if (!externalConversationId)
        return;
    const jid = jidForConversation(String(providerAccount.providerId), externalConversationId);
    await removeRoute.call(ctx.app, makeAgentThreadQueueKey(jid, install.agentId, externalThreadId, install.providerAccountId));
}
async function externalThreadIdForInstall(threadId, conversation) {
    if (!threadId)
        return undefined;
    const thread = await getRuntimeStorage().repositories.conversations.getThread(threadId);
    if (thread?.conversationId !== conversation.id)
        return null;
    return thread.externalRef?.value?.trim() || null;
}
function routeStateForConversationInstall(input) {
    const folder = folderForAgentId(input.agent.id) ?? String(input.agent.id);
    const route = input.install.memorySubject.route;
    const configuredConversationId = route?.configuredConversationId;
    const configuredTrigger = route?.trigger;
    const fallbackTrigger = `@${(input.agent.name || folder).trim() || 'agent'}`;
    return {
        name: input.install.displayName || input.agent.name,
        folder,
        conversationId: typeof configuredConversationId === 'string' &&
            configuredConversationId.trim()
            ? configuredConversationId.trim()
            : input.conversation.id,
        providerAccountId: input.install.providerAccountId,
        trigger: typeof configuredTrigger === 'string' && configuredTrigger.trim()
            ? configuredTrigger.trim()
            : fallbackTrigger,
        added_at: input.install.createdAt,
        requiresTrigger: typeof route?.requiresTrigger === 'boolean'
            ? route.requiresTrigger
            : input.conversation.kind !== 'direct',
        conversationKind: input.conversation.kind === 'direct' ? 'dm' : 'channel',
    };
}
function jidForConversation(providerId, externalId) {
    const provider = getProvider(providerId);
    const trimmed = externalId.trim();
    if (!provider?.jidPrefix || trimmed.startsWith(provider.jidPrefix)) {
        return trimmed;
    }
    return `${provider.jidPrefix}${trimmed}`;
}
