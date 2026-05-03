import type { GroupProcessingDeps } from './group-processing-types.js';
import { resolveConfiguredAllowedTools } from './configured-agent-tools.js';

export function memoryScopeForConversationKind(
  conversationKind?: string,
): 'user' | 'group' {
  return conversationKind === 'dm' ? 'user' : 'group';
}

export async function resolveTurnAllowedTools(
  deps: Pick<GroupProcessingDeps, 'getToolRepository'>,
  turnContext?: { appId: string; agentId: string } | null,
) {
  if (!turnContext) return undefined;
  return resolveConfiguredAllowedTools({
    repository: deps.getToolRepository?.(),
    appId: turnContext.appId,
    agentId: turnContext.agentId,
  });
}
