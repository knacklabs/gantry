import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { Agent } from '../../../domain/agent/agent.js';
import { folderForAgentId } from '../../../domain/agent/agent-folder-id.js';
import type {
  Conversation,
  ConversationThreadId,
} from '../../../domain/conversation/conversation.js';
import type {
  ConversationInstall,
  ProviderAccountId,
} from '../../../domain/provider/provider.js';
import { makeAgentThreadQueueKey } from '../../../shared/thread-queue-key.js';
import { getProvider } from '../../../channels/provider-registry.js';
import type { ControlRouteContext } from '../handler-context.js';

interface RuntimeConversationRouteState {
  name: string;
  folder: string;
  providerAccountId: string;
  trigger: string;
  added_at: string;
  requiresTrigger: boolean;
  conversationKind: 'dm' | 'channel';
}

export async function projectConversationInstallToRuntime(
  ctx: ControlRouteContext,
  install: ConversationInstall,
): Promise<void> {
  if (install.status !== 'active') {
    await removeConversationInstallFromRuntime(ctx, install);
    return;
  }
  const projectRoute = (ctx.app as { projectConversationRoute?: unknown })
    .projectConversationRoute;
  if (typeof projectRoute !== 'function') return;

  const repositories = getRuntimeStorage().repositories;
  const [agent, conversation] = await Promise.all([
    repositories.agents.getAgent(install.agentId),
    repositories.conversations.getConversation(install.conversationId),
  ]);
  if (!agent || !conversation) return;
  const externalThreadId = await externalThreadIdForInstall(
    install.threadId,
    conversation,
  );
  if (externalThreadId === null) return;
  const providerAccount =
    await repositories.providerAccounts.getProviderAccount(
      install.providerAccountId,
    );
  if (!providerAccount || providerAccount.status !== 'active') return;

  const externalConversationId = conversation.externalRef?.value?.trim();
  if (!externalConversationId) return;
  const jid = jidForConversation(
    String(providerAccount.providerId),
    externalConversationId,
  );
  await projectRoute.call(
    ctx.app,
    externalThreadId
      ? makeAgentThreadQueueKey(jid, undefined, externalThreadId)
      : jid,
    routeStateForConversationInstall({ agent, install, conversation }),
  );
}

export async function removeProviderAccountRoutesFromRuntime(
  ctx: ControlRouteContext,
  providerAccountId: ProviderAccountId,
): Promise<void> {
  const getRoutes = (ctx.app as { getConversationRoutes?: unknown })
    .getConversationRoutes;
  const removeRoute = (ctx.app as { unregisterConversationRoute?: unknown })
    .unregisterConversationRoute;
  if (typeof getRoutes !== 'function' || typeof removeRoute !== 'function') {
    return;
  }
  const routes = getRoutes.call(ctx.app) as Record<
    string,
    RuntimeConversationRouteState
  >;
  const routeKeys = Object.entries(routes)
    .filter(([, route]) => route.providerAccountId === providerAccountId)
    .map(([routeKey]) => routeKey);
  for (const routeKey of routeKeys) {
    await removeRoute.call(ctx.app, routeKey);
  }
}

export async function projectProviderAccountRoutesToRuntime(
  ctx: ControlRouteContext,
  providerAccountId: ProviderAccountId,
): Promise<void> {
  const repositories = getRuntimeStorage().repositories;
  const providerAccount =
    await repositories.providerAccounts.getProviderAccount(providerAccountId);
  if (!providerAccount || providerAccount.status !== 'active') return;

  const installs = await repositories.providerAccounts.listConversationInstalls(
    providerAccount.appId,
    providerAccount.agentId,
  );
  for (const install of installs) {
    if (install.providerAccountId === providerAccountId) {
      await projectConversationInstallToRuntime(ctx, install);
    }
  }
}

export async function removeConversationInstallFromRuntime(
  ctx: ControlRouteContext,
  install: ConversationInstall,
): Promise<void> {
  const removeRoute = (ctx.app as { unregisterConversationRoute?: unknown })
    .unregisterConversationRoute;
  if (typeof removeRoute !== 'function') return;

  const repositories = getRuntimeStorage().repositories;
  const conversation = await repositories.conversations.getConversation(
    install.conversationId,
  );
  if (!conversation) return;
  const externalThreadId = await externalThreadIdForInstall(
    install.threadId,
    conversation,
  );
  if (externalThreadId === null) return;
  const providerAccount =
    await repositories.providerAccounts.getProviderAccount(
      install.providerAccountId,
    );
  if (!providerAccount) return;

  const externalConversationId = conversation.externalRef?.value?.trim();
  if (!externalConversationId) return;
  const jid = jidForConversation(
    String(providerAccount.providerId),
    externalConversationId,
  );
  await removeRoute.call(
    ctx.app,
    makeAgentThreadQueueKey(
      jid,
      install.agentId,
      externalThreadId,
      install.providerAccountId,
    ),
  );
}

async function externalThreadIdForInstall(
  threadId: ConversationThreadId | undefined,
  conversation: Conversation,
): Promise<string | null | undefined> {
  if (!threadId) return undefined;
  const thread =
    await getRuntimeStorage().repositories.conversations.getThread(threadId);
  if (thread?.conversationId !== conversation.id) return null;
  return thread.externalRef?.value?.trim() || null;
}

function routeStateForConversationInstall(input: {
  agent: Agent;
  install: ConversationInstall;
  conversation: Conversation;
}): RuntimeConversationRouteState {
  const folder = folderForAgentId(input.agent.id) ?? String(input.agent.id);
  const route = (
    input.install.memorySubject as {
      route?: { trigger?: unknown; requiresTrigger?: unknown };
    }
  ).route;
  const configuredTrigger = route?.trigger;
  const fallbackTrigger = `@${(input.agent.name || folder).trim() || 'agent'}`;
  return {
    name: input.install.displayName || input.agent.name,
    folder,
    providerAccountId: input.install.providerAccountId,
    trigger:
      typeof configuredTrigger === 'string' && configuredTrigger.trim()
        ? configuredTrigger.trim()
        : fallbackTrigger,
    added_at: input.install.createdAt,
    requiresTrigger:
      typeof route?.requiresTrigger === 'boolean'
        ? route.requiresTrigger
        : input.conversation.kind !== 'direct',
    conversationKind: input.conversation.kind === 'direct' ? 'dm' : 'channel',
  };
}

function jidForConversation(providerId: string, externalId: string): string {
  const provider = getProvider(providerId);
  const trimmed = externalId.trim();
  if (!provider?.jidPrefix || trimmed.startsWith(provider.jidPrefix)) {
    return trimmed;
  }
  return `${provider.jidPrefix}${trimmed}`;
}
