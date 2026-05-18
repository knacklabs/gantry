import { createHash } from 'node:crypto';

import { normalizeSubject } from './app-memory-boundaries.js';
import type {
  AppMemoryItem,
  MemoryKind,
  MemorySubjectType,
  NormalizedMemorySubject,
} from './memory-types.js';

export interface CanonicalMemoryItemRow {
  id: string;
  appId: string;
  agentId: string | null;
  subjectType: string;
  subjectId: string;
  userId: string | null;
  conversationId: string | null;
  threadId: string | null;
  kind: string;
  key: string;
  valueJson: unknown;
  sourceRefJson: unknown;
  confidence: number;
  status: string;
  lastObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function parseItemValue(row: CanonicalMemoryItemRow): {
  value: string;
  why: string | null;
} {
  const payload = parseJsonObject(row.valueJson);
  return {
    value: typeof payload.value === 'string' ? payload.value : '',
    why: typeof payload.why === 'string' ? payload.why : null,
  };
}

export function parseItemSource(row: CanonicalMemoryItemRow): {
  subject: NormalizedMemorySubject;
  source: string;
  evidenceIds: string[];
  isPinned: boolean;
  version: number;
  retrievalCount?: number;
  totalScore?: number;
  maxScore?: number;
} {
  const payload = parseJsonObject(row.sourceRefJson);
  const subjectPayload = parseJsonObject(JSON.stringify(payload.subject ?? {}));
  return {
    subject: normalizeSubject({
      appId: row.appId,
      agentId:
        typeof subjectPayload.agentId === 'string'
          ? subjectPayload.agentId
          : row.agentId || undefined,
      subjectType:
        typeof subjectPayload.subjectType === 'string'
          ? (subjectPayload.subjectType as MemorySubjectType)
          : undefined,
      subjectId:
        typeof subjectPayload.subjectId === 'string'
          ? subjectPayload.subjectId
          : row.subjectId,
      userId:
        typeof subjectPayload.userId === 'string'
          ? subjectPayload.userId
          : undefined,
      groupId:
        typeof subjectPayload.groupId === 'string'
          ? subjectPayload.groupId
          : undefined,
      channelId:
        typeof subjectPayload.channelId === 'string'
          ? subjectPayload.channelId
          : undefined,
      threadId:
        typeof subjectPayload.threadId === 'string'
          ? subjectPayload.threadId
          : undefined,
    }),
    source: typeof payload.source === 'string' ? payload.source : 'sdk',
    evidenceIds: Array.isArray(payload.evidenceIds)
      ? payload.evidenceIds.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
    isPinned: Boolean(payload.isPinned),
    version:
      typeof payload.version === 'number' && Number.isFinite(payload.version)
        ? payload.version
        : 1,
    retrievalCount:
      typeof payload.retrievalCount === 'number' &&
      Number.isFinite(payload.retrievalCount)
        ? payload.retrievalCount
        : undefined,
    totalScore:
      typeof payload.totalScore === 'number' &&
      Number.isFinite(payload.totalScore)
        ? payload.totalScore
        : undefined,
    maxScore:
      typeof payload.maxScore === 'number' && Number.isFinite(payload.maxScore)
        ? payload.maxScore
        : undefined,
  };
}

export function encodeItemSource(input: {
  subject: NormalizedMemorySubject;
  source: string;
  evidenceIds: string[];
  isPinned: boolean;
  version: number;
  retrievalCount?: number;
  totalScore?: number;
  maxScore?: number;
}): Record<string, unknown> {
  return {
    subject: input.subject,
    source: input.source,
    evidenceIds: input.evidenceIds,
    isPinned: input.isPinned,
    version: input.version,
    retrievalCount: input.retrievalCount ?? 0,
    totalScore: input.totalScore ?? 0,
    maxScore: input.maxScore ?? 0,
  };
}

export function clampConfidence(
  value: number | undefined,
  fallback = 0.7,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export function normalizeKind(value: string | undefined): MemoryKind {
  const allowed = new Set<MemoryKind>([
    'preference',
    'decision',
    'fact',
    'correction',
    'constraint',
    'reference',
  ]);
  return allowed.has(value as MemoryKind) ? (value as MemoryKind) : 'fact';
}

export function toAppItem(row: CanonicalMemoryItemRow): AppMemoryItem {
  const value = parseItemValue(row);
  const source = parseItemSource(row);
  const subject = source.subject;
  return {
    id: row.id,
    appId: row.appId,
    agentId: subject.agentId,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    ...(subject.userId ? { userId: subject.userId } : {}),
    ...(subject.groupId ? { groupId: subject.groupId } : {}),
    ...(subject.channelId ? { channelId: subject.channelId } : {}),
    ...(subject.threadId ? { threadId: subject.threadId } : {}),
    kind: row.kind as MemoryKind,
    key: row.key,
    value: value.value,
    why: value.why,
    confidence: row.confidence,
    isPinned: source.isPinned,
    version: source.version,
    source: source.source,
    evidenceIds: source.evidenceIds,
    ...(source.retrievalCount !== undefined
      ? { retrievalCount: source.retrievalCount }
      : {}),
    ...(source.totalScore !== undefined
      ? { totalScore: source.totalScore }
      : {}),
    ...(source.maxScore !== undefined ? { maxScore: source.maxScore } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function itemMatchesSubjectBoundary(
  row: CanonicalMemoryItemRow,
  context: NormalizedMemorySubject,
): boolean {
  const subject = parseItemSource(row).subject;
  if (row.appId !== context.appId) return false;
  if (subject.agentId !== context.agentId) return false;
  if (subject.subjectType !== context.subjectType) return false;
  if (subject.subjectId !== context.subjectId) return false;
  if (context.threadId) {
    return (
      subject.threadId === undefined || subject.threadId === context.threadId
    );
  }
  return subject.threadId === undefined;
}
