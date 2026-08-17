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
  const conversationRoutes = notificationRoutes.filter(
    (route) => route.conversationJid === executionConversation,
  );
  const executionAgentId = resolveJobExecutionAgentId(job);
  const resolveGroup = (providerAccountId: string | undefined) =>
    executionAgentId
      ? findConversationRouteForQueue(
          groups,
          makeAgentThreadQueueKey(
            executionConversation,
            executionAgentId,
            undefined,
            providerAccountId,
          ),
          (route) => agentIdForJobWorkspaceKey(route.folder),
        )
      : findSingleConversationRouteForChat(
          groups,
          executionConversation,
          undefined,
        );
  // Jobs stage and execute at the GROUP/CHANNEL (conversation) level; a thread is
  // a DELIVERY detail only and is NEVER used to resolve execution (omitted from
  // the queue key). The provider account is a separate, thread-independent
  // discriminator: prefer the first notification-route account (primary order)
  // that maps to a LIVE conversation route, so a stale/reordered route can't
  // select a dead account.
  const namedAccounts = conversationRoutes
    .map((route) => normalizeOptional(route.providerAccountId))
    .filter((account): account is string => account !== undefined);
  let group: ReturnType<typeof resolveGroup> = undefined;
  for (const account of namedAccounts) {
    const candidate = resolveGroup(account);
    if (candidate) {
      group = candidate;
      break;
    }
  }
  // Resolve conversation-wide ONLY when the job names no provider account at all.
  // If it names accounts but none is live, do NOT fall through to an unrelated
  // installation — the account is a discriminator, not a hint.
  if (!group && namedAccounts.length === 0) group = resolveGroup(undefined);
  if (!group) return null;
  // Delivery thread only (never affects the execution routing above): the pinned
  // execution thread, else the primary delivery route's own thread (incl. null).
  const deliveryThreadId =
    executionThreadId ?? conversationRoutes[0]?.threadId ?? null;
  const stopAliasJids = Array.from(
    new Set([
      executionConversation,
      ...notificationRoutes.map((route) => route.conversationJid),
    ]),
  );
  return {
    group,
    executionJid: executionConversation,
    threadId: deliveryThreadId,
    stopAliasJids,
  };
}

export function resolveJobExecutionAgentId(job: Job): string | undefined {
  const explicitAgentId = normalizeOptional(
    (job.execution_context as Record<string, unknown> | undefined)?.agentId,
  );
  if (explicitAgentId) return explicitAgentId;
  const workspaceKey =
    normalizeOptional(job.execution_context?.workspaceKey) ??
    normalizeOptional(job.workspace_key);
  return workspaceKey ? agentIdForJobWorkspaceKey(workspaceKey) : undefined;
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
