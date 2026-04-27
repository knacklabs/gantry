import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForGroupFolder,
} from '../memory/app-memory-boundaries.js';
import { AppMemoryService } from '../memory/app-memory-service.js';
import type { MemoryStatusSnapshot } from '../session/session-commands.js';

export async function getGroupMemoryStatus(
  groupFolder: string,
): Promise<MemoryStatusSnapshot> {
  const service = AppMemoryService.getInstance();
  const memories = await service.list({
    appId: DEFAULT_MEMORY_APP_ID,
    agentId: memoryAgentIdForGroupFolder(groupFolder),
    groupId: groupFolder,
    limit: 100,
  });
  const runs = await service.dreamingStatus({
    appId: DEFAULT_MEMORY_APP_ID,
    agentId: memoryAgentIdForGroupFolder(groupFolder),
  });
  return {
    items_by_kind: memories.reduce<Record<string, number>>((acc, item) => {
      acc[item.kind] = (acc[item.kind] || 0) + 1;
      return acc;
    }, {}),
    items_by_scope: memories.reduce<Record<string, number>>((acc, item) => {
      acc[item.subjectType] = (acc[item.subjectType] || 0) + 1;
      return acc;
    }, {}),
    top10_most_used: memories.slice(0, 10).map((item) => ({
      key: item.key,
      retrieval_count: 0,
    })),
    top10_stalest: memories.slice(-10).map((item) => ({
      key: item.key,
      updated_at: item.updatedAt,
    })),
    last_dream_run: runs[0]
      ? {
          at: runs[0].completedAt || runs[0].startedAt,
          summary: JSON.stringify(runs[0].summary),
        }
      : undefined,
  };
}

export async function saveGroupProcedureMemory(input: {
  groupFolder: string;
  threadId?: string | null;
  isAdminWrite: boolean;
  title: string;
  body: string;
}) {
  return AppMemoryService.getInstance().save({
    appId: DEFAULT_MEMORY_APP_ID,
    agentId: memoryAgentIdForGroupFolder(input.groupFolder),
    groupId: input.groupFolder,
    threadId: input.threadId || undefined,
    subjectType: 'group',
    kind: 'reference',
    key: `procedure:${input.title}`,
    value: input.body,
    source: 'explicit',
    confidence: 0.8,
    evidenceText: input.body,
    actorId: 'agent',
    isAdminWrite: input.isAdminWrite,
  });
}
