import {
  conversationBoundAgentIdsForRoute,
  projectCallableAgentTools,
} from '../../application/core-tools/callable-agent-tools.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentRepository } from '../../domain/ports/repositories.js';
import type { ConversationRoute } from '../../domain/types.js';
import type { InlineAgentLoopLaneInput } from '../../runtime/agent-inline.js';

export type InlineConfiguredAgents = Record<
  string,
  | {
      capabilities?: Array<{ id: string }>;
      delegates?: string[];
      persona?: string;
    }
  | null
  | undefined
>;

export async function resolveInlineCallableAgentManifest(
  laneInput: InlineAgentLoopLaneInput,
  repository: AgentRepository | undefined,
  configuredAgents?: InlineConfiguredAgents,
  conversationRoutes: Record<string, ConversationRoute> = {},
  toolsAvailable = true,
  warn?: (context: Record<string, unknown>, message: string) => void,
) {
  const run = laneInput.input;
  const delegates = configuredAgents?.[laneInput.group.folder]?.delegates ?? [];
  if (
    !toolsAvailable ||
    run.disableTools === true ||
    run.hideAuthorityTools === true ||
    !repository ||
    !run.appId ||
    !run.agentId ||
    run.parentTaskId != null ||
    !run.toolPolicyRules?.includes('AgentDelegation') ||
    delegates.length === 0
  ) {
    return [];
  }
  const agents = await repository.listAgents(run.appId as AppId);
  const conversationBoundAgentIds = conversationBoundAgentIdsForRoute({
    routes: conversationRoutes,
    chatJid: run.chatJid,
    threadId: run.threadId,
    callerAgentId: run.agentId,
    callerProviderAccountId: laneInput.group.providerAccountId,
  });
  const personasByAgentId = Object.fromEntries(
    Object.entries(configuredAgents ?? {}).flatMap(([folder, configured]) =>
      configured
        ? [[String(agentIdForFolder(folder)), configured.persona] as const]
        : [],
    ),
  );
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
