import { parseJsonObject } from './app-memory-canonical-codec.js';
import type {
  DreamingRunStatus,
  MemoryLifecycleProposal,
  MemoryReviewRecord,
  MemoryReviewSnapshot,
  MemorySubjectType,
} from './memory-types.js';

interface MemoryReviewRowLike {
  id: string;
  runId: string;
  appId: string;
  agentId: string;
  subjectType: string;
  subjectId: string;
  threadId: string | null;
  phase: string;
  proposalJson: string;
  status: string;
  itemVersionsJson: string;
  candidateVersionsJson: string;
  validationSummary: string;
  reviewSnapshotJson: string | null;
  decisionSource: string | null;
  reviewerId: string | null;
  decision: string | null;
  editedValue: string | null;
  editedReason: string | null;
  applyOutcome: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
}

function parseJsonStringRecord(value: string): Record<string, string> {
  const parsed = parseJsonObject(value);
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function parseJsonNumberRecord(value: string): Record<string, number> {
  const parsed = parseJsonObject(value);
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  );
}

function parseReviewProposal(value: string): MemoryLifecycleProposal {
  const parsed = parseJsonObject(value);
  const action = typeof parsed.action === 'string' ? parsed.action : '';
  return {
    action: action as MemoryLifecycleProposal['action'],
    ...(typeof parsed.candidateId === 'string'
      ? { candidateId: parsed.candidateId }
      : {}),
    ...(typeof parsed.itemId === 'string' ? { itemId: parsed.itemId } : {}),
    ...(Array.isArray(parsed.itemIds)
      ? {
          itemIds: parsed.itemIds.filter(
            (entry): entry is string => typeof entry === 'string',
          ),
        }
      : {}),
    ...(typeof parsed.targetItemId === 'string'
      ? { targetItemId: parsed.targetItemId }
      : {}),
    ...(typeof parsed.kind === 'string'
      ? { kind: parsed.kind as MemoryLifecycleProposal['kind'] }
      : {}),
    ...(typeof parsed.key === 'string' ? { key: parsed.key } : {}),
    ...(typeof parsed.value === 'string' ? { value: parsed.value } : {}),
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    confidence:
      typeof parsed.confidence === 'number' &&
      Number.isFinite(parsed.confidence)
        ? parsed.confidence
        : 0,
    evidenceIds: Array.isArray(parsed.evidenceIds)
      ? parsed.evidenceIds.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
  };
}

function isSnapshotEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    (e.role === 'active' || e.role === 'incoming') &&
    typeof e.sourceType === 'string' &&
    typeof e.text === 'string' &&
    typeof e.capturedAt === 'string'
  );
}

/**
 * Shape-check the frozen artifact. Malformed snapshots return null so callers
 * fall back to legacy (re-query) rendering instead of throwing on bad JSON.
 */
function parseReviewSnapshot(
  value: string | null,
): MemoryReviewSnapshot | null {
  if (!value) return null;
  const parsed = parseJsonObject(value) as Record<string, unknown>;
  if (parsed.schemaVersion !== 1) return null;
  if (!parsed.subject || typeof parsed.subject !== 'object') return null;
  if (!Array.isArray(parsed.evidence)) return null;
  if (!parsed.evidence.every(isSnapshotEvidence)) return null;
  return parsed as unknown as MemoryReviewSnapshot;
}

export function toMemoryReview(row: MemoryReviewRowLike): MemoryReviewRecord {
  return {
    id: row.id,
    runId: row.runId,
    appId: row.appId,
    agentId: row.agentId,
    subjectType: row.subjectType as MemorySubjectType,
    subjectId: row.subjectId,
    phase: row.phase as DreamingRunStatus['phase'],
    proposal: parseReviewProposal(row.proposalJson),
    status: row.status as MemoryReviewRecord['status'],
    itemVersions: parseJsonNumberRecord(row.itemVersionsJson),
    candidateVersions: parseJsonStringRecord(row.candidateVersionsJson),
    validationSummary: row.validationSummary,
    reviewSnapshotJson: row.reviewSnapshotJson,
    reviewSnapshot: parseReviewSnapshot(row.reviewSnapshotJson),
    decisionSource: row.decisionSource,
    reviewerId: row.reviewerId,
    decision: row.decision as MemoryReviewRecord['decision'],
    editedValue: row.editedValue,
    editedReason: row.editedReason,
    applyOutcome: row.applyOutcome,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decidedAt: row.decidedAt,
  };
}
