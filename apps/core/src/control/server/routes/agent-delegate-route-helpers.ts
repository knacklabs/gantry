import { resolveAgentToolRuntimeRules } from '../../../application/agents/agent-tool-runtime-rules.js';
import {
  callableAgentToolName,
  conversationBoundAgentIdsForRoute,
  projectCallableAgentTools,
} from '../../../application/core-tools/callable-agent-tools.js';
import {
  agentIdForFolder,
  folderForAgentId,
} from '../../../domain/agent/agent-folder-id.js';
import type { Agent } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type { ConversationRoute } from '../../../domain/types.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import { parseAgentThreadQueueKey } from '../../../shared/thread-queue-key.js';
import type {
  ControlAgentSettingsView,
  ControlRouteContext,
} from '../handler-context.js';

export async function loadAgentDelegateSettings(
  ctx: ControlRouteContext,
  appId: AppId,
): Promise<{ settings: ControlAgentSettingsView; revision: number }> {
  const latest =
    await getRuntimeStorage().repositories.settingsRevisions.getLatestSettingsRevision(
      appId,
    );
  return latest
    ? {
        settings: ctx.agentSettings.decodeRevisionDocument(
          latest.settingsDocument,
        ),
        revision: latest.revision,
      }
    : {
        settings: ctx.agentSettings.defaultSettings(),
        revision: 0,
      };
}

export function agentIdentityMap(agents: readonly Agent[]): Map<string, Agent> {
  const identities = new Map<string, Agent>();
  for (const agent of agents) {
    identities.set(String(agent.id), agent);
    const folder = folderForAgentId(agent.id);
    if (folder) identities.set(folder, agent);
  }
  return identities;
}

export async function resolveCallableDelegateRoster(input: {
  appId: AppId;
  orchestrator: Agent;
  folder: string;
  delegates: readonly string[];
  settings: ControlAgentSettingsView;
  conversationRoutes: Record<string, ConversationRoute>;
}) {
  if (input.orchestrator.status !== 'active') return [];
  const repositories = getRuntimeStorage().repositories;
  const agents = await repositories.agents.listAgents(input.appId);
  const conversationBoundAgentIds = new Set<string>();
  const threadIdsByConversationAndChat = new Map<string, Set<string>>();
  for (const [routeKey, route] of Object.entries(input.conversationRoutes)) {
    if (!route.conversationId) continue;
    const parsed = parseAgentThreadQueueKey(routeKey);
    if (!parsed.threadId) continue;
    const contextKey = `${route.conversationId}\0${parsed.chatJid}`;
    const threadIds =
      threadIdsByConversationAndChat.get(contextKey) ?? new Set<string>();
    threadIds.add(parsed.threadId);
    threadIdsByConversationAndChat.set(contextKey, threadIds);
  }
  for (const [routeKey, route] of Object.entries(input.conversationRoutes)) {
    const routeAgentId =
      route.agentId ?? String(agentIdForFolder(route.folder));
    if (routeAgentId !== String(input.orchestrator.id)) continue;
    const parsed = parseAgentThreadQueueKey(routeKey);
    const threadIds = parsed.threadId
      ? [parsed.threadId]
      : [
          undefined,
          ...(threadIdsByConversationAndChat.get(
            `${route.conversationId ?? ''}\0${parsed.chatJid}`,
          ) ?? []),
        ];
    for (const threadId of threadIds) {
      for (const agentId of conversationBoundAgentIdsForRoute({
        routes: input.conversationRoutes,
        chatJid: parsed.chatJid,
        threadId,
        callerAgentId: routeAgentId,
        callerProviderAccountId:
          parsed.providerAccountId ?? route.providerAccountId,
      })) {
        conversationBoundAgentIds.add(agentId);
      }
    }
  }
  const personasByAgentId = Object.fromEntries(
    Object.entries(input.settings.agents).map(([folder, agent]) => [
      String(agentIdForFolder(folder)),
      agent.persona,
    ]),
  );
  const identities = agentIdentityMap(agents);
  const toolPolicyRules =
    input.settings.agents[input.folder]?.accessPreset === 'locked'
      ? []
      : await resolveAgentToolRuntimeRules({
          repository: repositories.tools,
          appId: String(input.appId),
          agentId: String(input.orchestrator.id),
          errorSubject: 'Configured agent tool',
        });
  return projectCallableAgentTools({
    agents,
    callerAppId: String(input.appId),
    callerAgentId: String(input.orchestrator.id),
    callerFolder: input.folder,
    delegates: input.delegates,
    conversationBoundAgentIds,
    personasByAgentId,
    toolPolicyRules,
    warn: (context, message) => logger.warn(context, message),
  }).map((entry) => ({
    ref:
      input.delegates.find(
        (delegate) =>
          String(identities.get(delegate)?.id) === entry.targetAgentId,
      ) ?? entry.targetAgentId,
    agentId: entry.targetAgentId,
    toolName: callableAgentToolName(entry),
    displayName: entry.displayName,
    persona: entry.persona,
  }));
}
