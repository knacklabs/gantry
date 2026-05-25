import { getMemoryMaintenanceQueue } from '../memory/maintenance-queue.js';
import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForGroupFolder as memoryAgentIdForGroup,
} from '../memory/app-memory-boundaries.js';
import { resolveScopedMemorySubject } from '../memory/app-memory-subject-resolver.js';
import { AppMemoryService } from '../memory/app-memory-service.js';

const memoryMaintenanceQueue = getMemoryMaintenanceQueue();

function dreamingDedupeKey(input: {
  subjectType: string;
  subjectId: string;
}): string {
  return `dream:${input.subjectType}:${input.subjectId}`;
}

export async function runDreamingForGroup(input: {
  folder: string;
  conversationId?: string;
  userId?: string;
  defaultScope?: 'user' | 'group';
  activeThreadId?: string;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}) {
  const { subject } = resolveScopedMemorySubject({
    appId: DEFAULT_MEMORY_APP_ID,
    agentId: memoryAgentIdForGroup(input.folder),
    groupId: input.folder,
    conversationId: input.conversationId,
    userId: input.userId,
    threadId: input.activeThreadId,
    defaultScope: input.defaultScope,
  });
  const result = await memoryMaintenanceQueue.enqueueAndWait(
    input.folder,
    async () => {
      await AppMemoryService.getInstance().triggerDreaming({
        ...subject,
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        phase: 'all',
        signal: input.signal,
        deadlineAtMs: input.deadlineAtMs,
      });
    },
    dreamingDedupeKey({
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
    }),
    { signal: input.signal },
  );
  if (!result.queued) {
    if (result.reason === 'full')
      throw new Error('memory maintenance queue full');
    if (result.reason === 'invalid')
      throw new Error('invalid memory maintenance group');
  }
  return {
    queued: result.queued,
    pending: memoryMaintenanceQueue.getPendingCount(),
    deduped: result.deduped,
    reason: result.reason,
  };
}
