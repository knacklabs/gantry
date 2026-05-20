import type {
  Job,
  ConversationRoute as RuntimeConversationRecord,
} from '../domain/types.js';
import type { RuntimeAgentSessionRepository } from '../domain/repositories/ops-repo.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import { resolveJobNotificationRoutes } from './job-notification-routes.js';
import { buildBoundedMemoryRecallQuery } from '../memory/app-memory-recall-query.js';

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
  const group = groups[executionConversation];
  if (!group) return null;
  const stopAliasJids = Array.from(
    new Set([
      executionConversation,
      ...resolveJobNotificationRoutes(job).map(
        (route) => route.conversationJid,
      ),
    ]),
  );
  return {
    group,
    executionJid: executionConversation,
    threadId: normalizeOptional(job.execution_context?.threadId) ?? null,
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
