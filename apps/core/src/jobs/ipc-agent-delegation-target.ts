import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import type { AppId } from '../domain/app/app.js';
import type { ConversationRoute } from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { IpcDeps } from '../runtime/ipc-domain-types.js';
import { resolveRunnerIpcRoute } from '../runtime/ipc-route-authorization.js';
import {
  resolveTurnSelectedMcpServerIds,
  resolveTurnSelectedSkillContext,
  resolveTurnSemanticCapabilities,
  resolveTurnToolPolicy,
} from '../runtime/group-run-context.js';
import { CALLABLE_AGENT_SYNC_WAIT_MAX_MS } from '../application/core-tools/callable-agent-tools.js';
import {
  callableAgentToolName,
  projectCallableAgentTools,
  type CallableAgentToolManifestEntry,
} from '../application/core-tools/callable-agent-tools.js';
import {
  findConversationRouteForQueue,
  makeAgentThreadQueueKey,
  routesForConversationId,
} from '../shared/thread-queue-key.js';

interface DelegatedTaskOwner {
  appId: string;
  agentId: string;
  conversationId: string;
  threadId?: string | null;
}

export function resolveDelegatedAgentTimeouts(
  payload: Record<string, unknown>,
  executionTimeoutMaxMs: number,
) {
  return {
    timeoutMs:
      typeof payload.timeoutMs === 'number'
        ? Math.min(payload.timeoutMs, executionTimeoutMaxMs)
        : undefined,
    syncWaitTimeoutMs:
      typeof payload.syncWaitTimeoutMs === 'number'
        ? Math.min(payload.syncWaitTimeoutMs, CALLABLE_AGENT_SYNC_WAIT_MAX_MS)
        : undefined,
  };
}

export async function resolveDelegatedAgentTarget(input: {
  deps: IpcDeps;
  routes: Record<string, ConversationRoute>;
  owner: DelegatedTaskOwner;
  sourceAgentFolder: string;
  trustedProviderAccountId?: string | null;
  requestedProviderAccountId?: string;
  targetAgentId?: string;
  callableAgentToolName?: unknown;
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
  const targetRoutes =
    selectedAgentId === input.owner.agentId
      ? input.routes
      : routesForConversationId(input.routes, callerRoute.conversationId);
  const group = findConversationRouteForQueue(
    targetRoutes,
    makeAgentThreadQueueKey(
      input.owner.conversationId,
      selectedAgentId,
      input.owner.threadId,
      selectedAgentId === input.owner.agentId
        ? callerRoute.providerAccountId
        : undefined,
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
  const syntheticToolName =
    typeof input.callableAgentToolName === 'string'
      ? input.callableAgentToolName.trim()
      : '';
  const targetAgentId = group.agentId ?? agentIdForFolder(group.folder);
  let callableAgentEntry: CallableAgentToolManifestEntry | undefined;
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
        ok: false as const,
        message: 'Callable agent target is no longer permitted.',
        code: 'forbidden' as const,
      };
    }
    if (syntheticToolName) callableAgentEntry = permittedEntry;
  }
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
    callableAgentEntry,
    providerAccountId: callerRoute.providerAccountId ?? null,
  };
}

async function findCallableAgentEntry(input: {
  deps: IpcDeps;
  owner: DelegatedTaskOwner;
  sourceAgentFolder: string;
  toolPolicyRules?: readonly string[];
  syntheticToolName: string;
  targetAgentId: string;
}): Promise<CallableAgentToolManifestEntry | undefined> {
  const repository = input.deps.getAgentRepository?.();
  const configuredAgents =
    input.deps.getPermissionRuntimeSettings?.()?.agents ?? {};
  const delegates = configuredAgents[input.sourceAgentFolder]?.delegates ?? [];
  if (!repository || delegates.length === 0) {
    return undefined;
  }
  const manifest = projectCallableAgentTools({
    agents: await repository.listAgents(input.owner.appId as AppId),
    callerAppId: input.owner.appId,
    callerAgentId: input.owner.agentId,
    callerFolder: input.sourceAgentFolder,
    delegates,
    conversationBoundAgentIds: new Set([input.targetAgentId]),
    personasByAgentId: Object.fromEntries(
      Object.entries(configuredAgents).flatMap(([folder, configured]) =>
        configured
          ? [[String(agentIdForFolder(folder)), configured.persona] as const]
          : [],
      ),
    ),
    toolPolicyRules: input.toolPolicyRules,
    warn: logger.warn.bind(logger),
  });
  return manifest.find(
    (entry) =>
      entry.targetAgentId === input.targetAgentId &&
      (!input.syntheticToolName ||
        callableAgentToolName(entry) === input.syntheticToolName),
  );
}
