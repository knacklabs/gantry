import type {
  Job,
  ConversationRoute as RuntimeConversationRecord,
} from '../domain/types.js';

export function resolveExecutionContext(
  job: Job,
  groups: Record<string, RuntimeConversationRecord>,
): {
  group: RuntimeConversationRecord;
  executionJid: string;
  stopAliasJids: string[];
} | null {
  for (const linked of job.linked_sessions) {
    const group = groups[linked];
    if (group) {
      return {
        group,
        executionJid: linked,
        stopAliasJids: Array.from(new Set([...(job.linked_sessions || [])])),
      };
    }
  }

  const byFolder = Object.entries(groups).find(
    ([, group]) => group.folder === job.group_scope,
  );
  if (byFolder) {
    const stopAliasJids = Array.from(
      new Set([...(job.linked_sessions || []), byFolder[0]]),
    );
    return {
      group: byFolder[1],
      executionJid: stopAliasJids[0] || byFolder[0],
      stopAliasJids,
    };
  }

  return null;
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
