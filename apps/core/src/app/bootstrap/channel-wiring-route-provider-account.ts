import type { RuntimeApp } from './runtime-app.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import { resolveConversationRoute } from './runtime-app-routes.js';

type ProviderAccountBoundChannel = {
  providerId: string;
  providerAccountId: string;
  agentId: string;
  inboundProviderAccountIds?: string[];
  interactionCallbacks?: boolean;
  channel: { ownsJid(jid: string): boolean };
};

export type RouteRequest = {
  threadId?: string | null;
  sourceAgentFolder?: string;
  agentId?: string;
  providerAccountId?: string;
};

export function findBoundChannelForProviderAccount<
  T extends ProviderAccountBoundChannel,
>(
  channels: T[],
  jid: string,
  providerAccountId?: string,
): T['channel'] | undefined {
  const matches = channels.filter(
    (bound) =>
      (!providerAccountId || bound.providerAccountId === providerAccountId) &&
      bound.channel.ownsJid(jid),
  );
  if (providerAccountId) return matches[0]?.channel;
  return matches.length === 1 ? matches[0]?.channel : undefined;
}

export function resolveRouteProviderAccountId(
  input: {
    app: RuntimeApp;
    jid: string;
  } & RouteRequest,
): string | undefined {
  return resolveConversationRoute(
    input.app.getConversationRoutes(),
    input.jid,
    input.threadId,
    input.agentId ??
      (input.sourceAgentFolder
        ? agentIdForFolder(input.sourceAgentFolder)
        : undefined),
  )?.providerAccountId;
}

export function findBoundChannelForRequest<
  T extends ProviderAccountBoundChannel,
>(
  app: RuntimeApp,
  channels: T[],
  jid: string,
  providerAccountId?: string,
  request?: RouteRequest,
): T['channel'] | undefined {
  const targetProviderAccountId =
    providerAccountId ??
    request?.providerAccountId ??
    resolveRouteProviderAccountId({
      app,
      jid,
      ...request,
    });
  const exact = findBoundChannelForProviderAccount(
    channels,
    jid,
    targetProviderAccountId,
  );
  const targetAgentId =
    request?.agentId ??
    (request?.sourceAgentFolder
      ? agentIdForFolder(request.sourceAgentFolder)
      : undefined);
  if (!targetProviderAccountId) {
    if (exact || !targetAgentId) return exact;

    // Some internal notifications are routed after a permission/review flow
    // that may not carry the provider account. Recover only when the request
    // agent has exactly one live account that owns this JID.
    const agentMatches = channels.filter(
      (bound) => bound.agentId === targetAgentId && bound.channel.ownsJid(jid),
    );
    return agentMatches.length === 1 ? agentMatches[0]!.channel : undefined;
  }
  if (!exact) {
    if (!targetAgentId) return undefined;

    // A persisted route can outlive a provider-account rename or rotation.
    // Recover only when the request agent has exactly one live account that
    // owns this JID; never guess between accounts or agents.
    const agentMatches = channels.filter(
      (bound) => bound.agentId === targetAgentId && bound.channel.ownsJid(jid),
    );
    return agentMatches.length === 1 ? agentMatches[0]!.channel : undefined;
  }
  const target = channels.find(
    (bound) =>
      bound.providerAccountId === targetProviderAccountId &&
      bound.channel === exact,
  );
  if (target?.interactionCallbacks !== false) return exact;
  return (
    channels.find(
      (bound) =>
        bound.providerId === target.providerId &&
        bound.interactionCallbacks === true &&
        bound.inboundProviderAccountIds?.includes(targetProviderAccountId) &&
        bound.channel.ownsJid(jid),
    )?.channel ?? exact
  );
}
