import type {
  Job,
  ConversationRoute as RuntimeConversationRecord,
} from '../domain/types.js';
import type { RuntimeAgentSessionRepository } from '../domain/repositories/ops-repo.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import { agentIdForJobWorkspaceKey } from '../application/jobs/job-tool-policy.js';
import { resolveJobNotificationRoutes } from './job-notification-routes.js';
import { buildBoundedMemoryRecallQuery } from '../memory/app-memory-recall-query.js';
import {
  findConversationRouteForQueue,
  findSingleConversationRouteForChat,
  makeAgentThreadQueueKey,
} from '../shared/thread-queue-key.js';

export function resolveExecutionContext(
  job: Job,
  groups: Record<string, RuntimeConversationRecord>,
): {
  group: RuntimeConversationRecord;
  executionJid: string;
  threadId: string | null;
  stopAliasJids: string[];
} | null {
  const executionConversation = normalizeOptional(
    job.execution_context?.conversationJid,
  );
  if (!executionConversation) return null;
  const executionThreadId = normalizeOptional(job.execution_context?.threadId);
  const notificationRoutes = resolveJobNotificationRoutes(job);
  const primaryExecutionRoute = notificationRoutes.find(
    (route) =>
      route.conversationJid === executionConversation &&
      (executionThreadId === undefined ||
        (route.threadId ?? null) === executionThreadId),
  );
  const executionProviderAccountId = normalizeOptional(
    primaryExecutionRoute?.providerAccountId,
  );
  const explicitAgentId = normalizeOptional(
    (job.execution_context as Record<string, unknown> | undefined)?.agentId,
  );
  const workspaceKey =
    normalizeOptional(job.execution_context?.workspaceKey) ??
    normalizeOptional(job.workspace_key);
  const executionAgentId = explicitAgentId
    ? explicitAgentId
    : workspaceKey
      ? agentIdForJobWorkspaceKey(workspaceKey)
      : undefined;
  const group = executionAgentId
    ? findConversationRouteForQueue(
        groups,
        makeAgentThreadQueueKey(
          executionConversation,
          executionAgentId,
          executionThreadId,
          executionProviderAccountId,
        ),
        (route) => agentIdForJobWorkspaceKey(route.folder),
      )
    : findSingleConversationRouteForChat(
        groups,
        executionConversation,
        executionThreadId,
      );
  if (!group) return null;
  const stopAliasJids = Array.from(
    new Set([
      executionConversation,
      ...notificationRoutes.map((route) => route.conversationJid),
    ]),
  );
  return {
    group,
    executionJid: executionConversation,
    threadId: executionThreadId ?? primaryExecutionRoute?.threadId ?? null,
    stopAliasJids,
  };
}

export function resolveExecutionMemoryContext(input: {
  conversationKind?: RuntimeConversationRecord['conversationKind'];
  executionJid: string;
}): {
  memoryDefaultScope: 'user' | 'group';
  memoryUserId?: string;
} {
  if (input.conversationKind === 'dm') {
    return {
      memoryDefaultScope: 'user',
      memoryUserId: input.executionJid,
    };
  }
  return { memoryDefaultScope: 'group' };
}

function normalizeOptional(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function buildExecutionTurnContextInput(input: {
  agentFolder: string;
  executionProviderId: ExecutionProviderId;
  executionJid: string;
  threadId?: string | null;
  conversationKind?: RuntimeConversationRecord['conversationKind'];
  memoryUserId?: string;
  jobId?: string;
  query?: string;
}): Parameters<
  NonNullable<RuntimeAgentSessionRepository['getAgentTurnContext']>
>[0] {
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

export function parseTriggerRequesterSessionId(
  requestedBy: string,
): string | null {
  try {
    const parsed = JSON.parse(requestedBy) as Record<string, unknown>;
    if (
      parsed.kind === 'sdk' &&
      typeof parsed.sessionId === 'string' &&
      parsed.sessionId.trim()
    ) {
      return parsed.sessionId;
    }
  } catch {
    // Invalid requestedBy metadata simply means there is no SDK session id.
  }
  return null;
}
