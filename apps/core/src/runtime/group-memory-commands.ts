import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForGroupFolder,
} from '../memory/app-memory-boundaries.js';
import {
  resolveScopedMemorySubject,
  searchInputForResolvedMemorySubject,
} from '../memory/app-memory-subject-resolver.js';
import { AppMemoryService } from '../memory/app-memory-service.js';
import type { AppMemoryItem } from '../memory/memory-types.js';
import type { MemoryStatusSnapshot } from '../session/session-command-format.js';

type MemoryEmbeddingsStatus = 'disabled' | 'configured';

type MemoryItemUsageMetadata = AppMemoryItem & {
  retrievalCount?: unknown;
  retrieval_count?: unknown;
  metadata?: Record<string, unknown>;
  sourceRef?: Record<string, unknown>;
  sourceRefJson?: unknown;
};

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseRetrievalCount(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.trunc(numeric);
}

function retrievalCountFromMemoryMetadata(item: AppMemoryItem): number {
  const extended = item as MemoryItemUsageMetadata;
  const sourceRefJson = parseJsonObject(extended.sourceRefJson);
  return parseRetrievalCount(
    extended.retrievalCount ??
      extended.retrieval_count ??
      extended.metadata?.retrievalCount ??
      extended.metadata?.retrieval_count ??
      extended.sourceRef?.retrievalCount ??
      sourceRefJson.retrievalCount,
  );
}

function compareUpdatedAtAsc(a: AppMemoryItem, b: AppMemoryItem): number {
  const timeDiff =
    new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
  if (timeDiff !== 0) return timeDiff;
  return a.key.localeCompare(b.key);
}

export async function getGroupMemoryStatus(
  input:
    | string
    | {
        folder: string;
        conversationId?: string;
        userId?: string;
        threadId?: string | null;
        defaultScope?: 'user' | 'group';
      },
  options: { embeddings?: MemoryEmbeddingsStatus } = {},
): Promise<MemoryStatusSnapshot> {
  const service = AppMemoryService.getInstance();
  const context =
    typeof input === 'string'
      ? { folder: input }
      : {
          ...input,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        };
  const subject = resolveScopedMemorySubject({
    appId: DEFAULT_MEMORY_APP_ID,
    agentId: memoryAgentIdForGroupFolder(context.folder),
    groupId: context.folder,
    conversationId: context.conversationId,
    userId: context.userId,
    threadId: context.threadId || undefined,
    defaultScope: context.defaultScope,
  }).subject;
  const memories = await service.list({
    ...searchInputForResolvedMemorySubject(subject),
    limit: 100,
  });
  const runs = await service.dreamingStatus({
    ...subject,
    appId: subject.appId,
    agentId: subject.agentId,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
  });
  const topUsed = memories
    .map((item) => ({
      key: item.key,
      retrieval_count: retrievalCountFromMemoryMetadata(item),
      updatedAt: item.updatedAt,
    }))
    .sort((a, b) => {
      const countDiff = b.retrieval_count - a.retrieval_count;
      if (countDiff !== 0) return countDiff;
      const timeDiff =
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.key.localeCompare(b.key);
    })
    .slice(0, 10)
    .map(({ key, retrieval_count }) => ({ key, retrieval_count }));
  return {
    items_by_kind: memories.reduce<Record<string, number>>((acc, item) => {
      acc[item.kind] = (acc[item.kind] || 0) + 1;
      return acc;
    }, {}),
    items_by_scope: memories.reduce<Record<string, number>>((acc, item) => {
      acc[item.subjectType] = (acc[item.subjectType] || 0) + 1;
      return acc;
    }, {}),
    top10_most_used: topUsed,
    top10_stalest: [...memories]
      .sort(compareUpdatedAtAsc)
      .slice(0, 10)
      .map((item) => ({
        key: item.key,
        updated_at: item.updatedAt,
      })),
    retrieval: {
      searchMode: 'lexical_keyword',
      embeddings: options.embeddings ?? 'disabled',
      vectorSearch: 'inactive',
    },
    last_dream_run: runs[0]
      ? {
          at: runs[0].completedAt || runs[0].startedAt,
          summary: JSON.stringify(runs[0].summary),
        }
      : undefined,
  };
}

export async function saveGroupProcedureMemory(input: {
  folder: string;
  conversationId?: string;
  userId?: string;
  defaultScope?: 'user' | 'group';
  threadId?: string | null;
  isAdminWrite: boolean;
  title: string;
  body: string;
}) {
  const { subject } = resolveScopedMemorySubject({
    appId: DEFAULT_MEMORY_APP_ID,
    agentId: memoryAgentIdForGroupFolder(input.folder),
    groupId: input.folder,
    conversationId: input.conversationId,
    userId: input.userId,
    threadId: input.threadId || undefined,
    defaultScope: input.defaultScope,
  });
  return AppMemoryService.getInstance().save({
    ...subject,
    appId: subject.appId,
    agentId: subject.agentId,
    subjectType: subject.subjectType,
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
