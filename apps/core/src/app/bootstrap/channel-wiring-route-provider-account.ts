import type { RuntimeApp } from './runtime-app.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import { resolveConversationRoute } from './runtime-app-routes.js';

type ProviderAccountBoundChannel = {
  providerId: string;
  providerAccountId: string;
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
  if (!targetProviderAccountId || !exact) return exact;
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
