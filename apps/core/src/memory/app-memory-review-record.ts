import { parseJsonObject } from './app-memory-canonical-codec.js';
import type {
  DreamingRunStatus,
  MemoryLifecycleProposal,
  MemoryReviewRecord,
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
