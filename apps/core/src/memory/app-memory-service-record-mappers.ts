import { parseJsonObject } from './app-memory-canonical-codec.js';
import type {
  DreamingRunStatus,
  MemoryEvidenceRecord,
  MemorySubjectType,
} from './memory-types.js';

export function conversationIdForChannel(
  channelId: string | undefined,
): string | null {
  if (!channelId) return null;
  return channelId.startsWith('conversation:')
    ? channelId
    : `conversation:${channelId}`;
}

type MemoryEvidenceRow = {
  id: string;
  appId: string;
  agentId: string;
  subjectType: string;
  subjectId: string;
  userId: string | null;
  groupId: string | null;
  channelId: string | null;
  threadId: string | null;
  sourceType: string;
  sourceId: string | null;
  actorId: string | null;
  text: string;
  metadataJson: string | null;
  createdAt: string;
};

type MemoryDreamRunRow = {
  id: string;
  appId: string;
  agentId: string;
  subjectType: string;
  subjectId: string;
  threadId: string | null;
  phase: string;
  status: string;
  summaryJson: string | null;
  startedAt: string;
  completedAt: string | null;
};

export function toEvidence(row: MemoryEvidenceRow): MemoryEvidenceRecord {
  return {
    id: row.id,
    appId: row.appId,
    agentId: row.agentId,
    subjectType: row.subjectType as MemorySubjectType,
    subjectId: row.subjectId,
    ...(row.userId ? { userId: row.userId } : {}),
    ...(row.groupId ? { groupId: row.groupId } : {}),
    ...(row.channelId ? { channelId: row.channelId } : {}),
    sourceType: row.sourceType as MemoryEvidenceRecord['sourceType'],
    sourceId: row.sourceId,
    actorId: row.actorId,
    text: row.text,
    metadata: parseJsonObject(row.metadataJson),
    createdAt: row.createdAt,
  };
}

export function toRun(row: MemoryDreamRunRow): DreamingRunStatus {
  return {
    runId: row.id,
    appId: row.appId,
    agentId: row.agentId,
    subjectType: row.subjectType as MemorySubjectType,
    subjectId: row.subjectId,
    phase: row.phase as DreamingRunStatus['phase'],
    status: row.status as DreamingRunStatus['status'],
    summary: parseJsonObject(row.summaryJson),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}
