import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import type { ConversationRoute } from '../domain/types.js';
import type { IpcDeps } from '../runtime/ipc-domain-types.js';
import { resolveRunnerIpcRoute } from '../runtime/ipc-route-authorization.js';
import {
  resolveTurnSelectedMcpServerIds,
  resolveTurnSelectedSkillContext,
  resolveTurnSemanticCapabilities,
  resolveTurnToolPolicy,
} from '../runtime/group-run-context.js';
import {
  findConversationRouteForQueue,
  makeAgentThreadQueueKey,
} from '../shared/thread-queue-key.js';

interface DelegatedTaskOwner {
  appId: string;
  agentId: string;
  conversationId: string;
  threadId?: string | null;
}

export async function resolveDelegatedAgentTarget(input: {
  deps: IpcDeps;
  routes: Record<string, ConversationRoute>;
  owner: DelegatedTaskOwner;
  sourceAgentFolder: string;
  trustedProviderAccountId?: string | null;
  requestedProviderAccountId?: string;
  targetAgentId?: string;
}) {
  let callerRoute: ReturnType<typeof resolveRunnerIpcRoute>;
  try {
    callerRoute = resolveRunnerIpcRoute({
      routes: input.routes,
      sourceAgentFolder: input.sourceAgentFolder,
      targetJid: input.owner.conversationId,
      threadId: input.owner.threadId ?? undefined,
      providerAccountId: input.trustedProviderAccountId ?? undefined,
    });
  } catch {
    return {
      ok: false as const,
      message:
        'Delegated task conversation route is ambiguous or unauthorized.',
      code: 'forbidden' as const,
    };
  }
  if (
    input.requestedProviderAccountId &&
    input.requestedProviderAccountId !== callerRoute.providerAccountId
  ) {
    return {
      ok: false as const,
      message:
        'Delegated task provider account does not match the caller route.',
      code: 'forbidden' as const,
    };
  }
  const selectedAgentId = input.targetAgentId ?? input.owner.agentId;
  const group = findConversationRouteForQueue(
    input.routes,
    makeAgentThreadQueueKey(
      input.owner.conversationId,
      selectedAgentId,
      input.owner.threadId,
      callerRoute.providerAccountId,
    ),
    (route) => route.agentId ?? agentIdForFolder(route.folder),
  );
  if (!group) {
    return {
      ok: false as const,
      message: input.targetAgentId
        ? `Target agent is not bound to this conversation: ${input.targetAgentId}`
        : 'Delegated task conversation is unavailable.',
      code: 'not_found' as const,
    };
  }
  const callerToolPolicy = await resolveTurnToolPolicy(input.deps, input.owner);
  if (!callerToolPolicy.toolPolicyRules?.includes('AgentDelegation')) {
    return {
      ok: false as const,
      message: 'delegate_task requires AgentDelegation access.',
      code: 'forbidden' as const,
    };
  }
  const targetAgentId = group.agentId ?? agentIdForFolder(group.folder);
  const targetOwner = { ...input.owner, agentId: targetAgentId };
  const [toolPolicy, selectedSkillContext, semanticCapabilities] =
    await Promise.all([
      targetAgentId === input.owner.agentId
        ? Promise.resolve(callerToolPolicy)
        : resolveTurnToolPolicy(input.deps, targetOwner),
      resolveTurnSelectedSkillContext(input.deps, targetOwner),
      resolveTurnSemanticCapabilities(input.deps, targetOwner),
    ]);
  const attachedMcpSourceIds = await resolveTurnSelectedMcpServerIds(
    input.deps,
    targetOwner,
    toolPolicy.toolPolicyRules,
  );
  return {
    ok: true as const,
    group,
    targetAgentId,
    targetOwner,
    toolPolicy,
    selectedSkillContext,
    semanticCapabilities,
    attachedMcpSourceIds,
    providerAccountId: callerRoute.providerAccountId ?? null,
  };
}
