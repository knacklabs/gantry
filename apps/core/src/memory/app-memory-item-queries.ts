import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type { PatternCandidateSubject } from '../domain/ports/pattern-candidates.js';
import {
  detectPatternCandidates,
  type PatternCandidateDraft,
  type PatternTranscriptTurn,
} from '../shared/pattern-candidate-detection.js';
import { PATTERN_INTENSIFY_DELTA } from '../shared/pattern-candidate-policy.js';
import {
  itemMatchesSubjectBoundary,
  parseJsonObject,
  parseItemSource,
  type CanonicalMemoryItemRow,
} from './app-memory-canonical-codec.js';
import { normalizeSubject, subjectIdFor } from './app-memory-boundaries.js';
import {
  nowIso,
  withStatementTimeout,
} from './app-memory-service-query-helpers.js';
import { hasDreamingStatusSubjectScope } from './app-memory-service-dreaming.js';
import { toRun } from './app-memory-service-record-mappers.js';
import type {
  BlockedDreamDecision,
  DemoteDreamingMemoryInput,
  DeleteAppMemoryInput,
  DreamingRunStatus,
  MemoryBoundaryContext,
  MemorySubjectType,
  NormalizedMemorySubject,
} from './memory-types.js';

type Db = NodePgDatabase<typeof pgSchema>;

export async function findActiveMemoryByKey(input: {
  db: Db;
  subject: NormalizedMemorySubject;
  key: string;
}): Promise<CanonicalMemoryItemRow | null> {
  const rows = await input.db
    .select()
    .from(pgSchema.memoryItemsPostgres)
    .where(
      and(
        eq(pgSchema.memoryItemsPostgres.status, 'active'),
        eq(pgSchema.memoryItemsPostgres.appId, input.subject.appId),
        eq(pgSchema.memoryItemsPostgres.agentId, input.subject.agentId),
        eq(pgSchema.memoryItemsPostgres.subjectType, input.subject.subjectType),
        eq(pgSchema.memoryItemsPostgres.subjectId, subjectIdFor(input.subject)),
        sql`${pgSchema.memoryItemsPostgres.sourceRefJson} @> ${JSON.stringify({ subject: { agentId: input.subject.agentId, subjectType: input.subject.subjectType, subjectId: input.subject.subjectId } })}::jsonb`,
        eq(pgSchema.memoryItemsPostgres.key, input.key.trim()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listDreamingStatuses(
  db: Db,
  input: Partial<MemoryBoundaryContext> & {
    subjectType?: MemorySubjectType;
    subjectId?: string;
  } = {},
  options: { signal?: AbortSignal; statementTimeoutMs?: number } = {},
): Promise<DreamingRunStatus[]> {
  options.signal?.throwIfAborted();
  const hasSubjectScope = hasDreamingStatusSubjectScope(input);
  const subject = normalizeSubject(input);
  const subjectFilters = hasSubjectScope
    ? [
        eq(pgSchema.memoryDreamRunsPostgres.subjectType, subject.subjectType),
        eq(pgSchema.memoryDreamRunsPostgres.subjectId, subject.subjectId),
      ]
    : [];
  const rows = (await withStatementTimeout(
    db,
    options.statementTimeoutMs,
    (timeoutMs) =>
      sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`,
    (queryDb) =>
      queryDb
        .select()
        .from(pgSchema.memoryDreamRunsPostgres)
        .where(
          and(
            eq(pgSchema.memoryDreamRunsPostgres.appId, subject.appId),
            eq(pgSchema.memoryDreamRunsPostgres.agentId, subject.agentId),
            ...subjectFilters,
          ),
        )
        .orderBy(desc(pgSchema.memoryDreamRunsPostgres.startedAt))
        .limit(20),
  )) as Array<typeof pgSchema.memoryDreamRunsPostgres.$inferSelect>;
  options.signal?.throwIfAborted();
  return rows.map(toRun);
}

export async function listRecentBlockedDreamDecisions(
  db: Db,
  input: Partial<MemoryBoundaryContext> & {
    subjectType?: MemorySubjectType;
    subjectId?: string;
  } = {},
  options: {
    signal?: AbortSignal;
    statementTimeoutMs?: number;
    limit?: number;
  } = {},
): Promise<BlockedDreamDecision[]> {
  options.signal?.throwIfAborted();
  const hasSubjectScope = hasDreamingStatusSubjectScope(input);
  const subject = normalizeSubject(input);
  const subjectFilters = hasSubjectScope
    ? [
        eq(pgSchema.memoryDreamRunsPostgres.subjectType, subject.subjectType),
        eq(pgSchema.memoryDreamRunsPostgres.subjectId, subject.subjectId),
      ]
    : [];
  const limit =
    options.limit && Number.isSafeInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, 25)
      : 10;
  type BlockedDreamDecisionRow = {
    id: string;
    runId: string;
    itemId: string | null;
    candidateId: string | null;
    rationale: string;
    createdAt: string;
    subjectType: string;
    subjectId: string;
    itemKind: string | null;
    itemKey: string | null;
    itemValue: string | null;
    candidateKind: string | null;
    candidateKey: string | null;
    candidateValue: string | null;
  };
  const rows = (await withStatementTimeout(
    db,
    options.statementTimeoutMs,
    (timeoutMs) =>
      sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`,
    (queryDb) =>
      queryDb
        .select({
          id: pgSchema.memoryDreamDecisionsPostgres.id,
          runId: pgSchema.memoryDreamDecisionsPostgres.runId,
          itemId: pgSchema.memoryDreamDecisionsPostgres.itemId,
          candidateId: pgSchema.memoryDreamDecisionsPostgres.candidateId,
          rationale: pgSchema.memoryDreamDecisionsPostgres.rationale,
          createdAt: pgSchema.memoryDreamDecisionsPostgres.createdAt,
          subjectType: pgSchema.memoryDreamRunsPostgres.subjectType,
          subjectId: pgSchema.memoryDreamRunsPostgres.subjectId,
          itemKind: pgSchema.memoryItemsPostgres.kind,
          itemKey: pgSchema.memoryItemsPostgres.key,
          itemValue: sql<
            string | null
          >`${pgSchema.memoryItemsPostgres.valueJson}->>'value'`,
          candidateKind: pgSchema.memoryCandidatesPostgres.kind,
          candidateKey: pgSchema.memoryCandidatesPostgres.key,
          candidateValue: pgSchema.memoryCandidatesPostgres.value,
        })
        .from(pgSchema.memoryDreamDecisionsPostgres)
        .innerJoin(
          pgSchema.memoryDreamRunsPostgres,
          and(
            eq(
              pgSchema.memoryDreamDecisionsPostgres.runId,
              pgSchema.memoryDreamRunsPostgres.id,
            ),
            eq(pgSchema.memoryDreamRunsPostgres.appId, subject.appId),
            eq(pgSchema.memoryDreamRunsPostgres.agentId, subject.agentId),
          ),
        )
        .leftJoin(
          pgSchema.memoryCandidatesPostgres,
          and(
            eq(
              pgSchema.memoryDreamDecisionsPostgres.candidateId,
              pgSchema.memoryCandidatesPostgres.id,
            ),
            eq(pgSchema.memoryCandidatesPostgres.appId, subject.appId),
            eq(pgSchema.memoryCandidatesPostgres.agentId, subject.agentId),
          ),
        )
        .leftJoin(
          pgSchema.memoryItemsPostgres,
          and(
            eq(
              pgSchema.memoryDreamDecisionsPostgres.itemId,
              pgSchema.memoryItemsPostgres.id,
            ),
            eq(pgSchema.memoryItemsPostgres.appId, subject.appId),
            eq(pgSchema.memoryItemsPostgres.agentId, subject.agentId),
          ),
        )
        .where(
          and(
            eq(pgSchema.memoryDreamDecisionsPostgres.appId, subject.appId),
            eq(pgSchema.memoryDreamDecisionsPostgres.agentId, subject.agentId),
            eq(pgSchema.memoryDreamDecisionsPostgres.action, 'blocked'),
            ...subjectFilters,
          ),
        )
        .orderBy(desc(pgSchema.memoryDreamDecisionsPostgres.createdAt))
        .limit(limit),
  )) as BlockedDreamDecisionRow[];
  options.signal?.throwIfAborted();
  return rows.map((row) => ({
    appId: subject.appId,
    agentId: subject.agentId,
    subjectType: row.subjectType as MemorySubjectType,
    subjectId: row.subjectId,
    id: row.id,
    runId: row.runId,
    itemId: row.itemId,
    candidateId: row.candidateId,
    rationale: row.rationale,
    kind: row.candidateKind ?? row.itemKind,
    key: row.candidateKey ?? row.itemKey,
    value: row.candidateValue ?? row.itemValue,
    createdAt: row.createdAt,
  }));
}

export async function getOwnedMemoryItem(input: {
  db: Db;
  context: NormalizedMemorySubject;
  id: string;
}): Promise<CanonicalMemoryItemRow | null> {
  const rows = await input.db
    .select()
    .from(pgSchema.memoryItemsPostgres)
    .where(
      and(
        eq(pgSchema.memoryItemsPostgres.id, input.id),
        eq(pgSchema.memoryItemsPostgres.status, 'active'),
        eq(pgSchema.memoryItemsPostgres.appId, input.context.appId),
      ),
    )
    .limit(1);
  const row = rows[0] ?? null;
  return row && itemMatchesSubjectBoundary(row, input.context) ? row : null;
}

export async function deleteOwnedMemoryItem(input: {
  db: Db;
  context: NormalizedMemorySubject;
  id: string;
  expectedVersion?: DeleteAppMemoryInput['expectedVersion'];
  isAdminWrite?: DeleteAppMemoryInput['isAdminWrite'];
}): Promise<{ deleted: boolean }> {
  const current = await getOwnedMemoryItem(input);
  if (!current) return { deleted: false };
  const currentSource = parseItemSource(current);
  if (currentSource.subject.subjectType === 'common' && !input.isAdminWrite) {
    throw new Error('common memory deletes require admin/service authority');
  }
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== currentSource.version
  ) {
    throw new Error('stale memory delete');
  }
  const [deleted] = await input.db
    .update(pgSchema.memoryItemsPostgres)
    .set({ status: 'deleted', updatedAt: nowIso() })
    .where(
      and(
        eq(pgSchema.memoryItemsPostgres.id, current.id),
        input.expectedVersion === undefined
          ? undefined
          : sql`(${pgSchema.memoryItemsPostgres.sourceRefJson}->>'version')::int = ${input.expectedVersion}`,
      ),
    )
    .returning({ id: pgSchema.memoryItemsPostgres.id });
  if (!deleted) throw new Error('stale memory delete');
  return { deleted: true };
}

export async function demoteDreamingPromotedMemoryItem(input: {
  db: Db;
  context: NormalizedMemorySubject;
  id: string;
  expectedVersion?: DemoteDreamingMemoryInput['expectedVersion'];
  isAdminWrite?: DemoteDreamingMemoryInput['isAdminWrite'];
  actorId?: DemoteDreamingMemoryInput['actorId'];
  reason?: DemoteDreamingMemoryInput['reason'];
}): Promise<{ demoted: boolean }> {
  const current = await getOwnedMemoryItem(input);
  if (!current) return { demoted: false };
  const currentSource = parseItemSource(current);
  if (currentSource.subject.subjectType === 'common' && !input.isAdminWrite) {
    throw new Error('common memory demotions require admin/service authority');
  }
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== currentSource.version
  ) {
    throw new Error('stale memory demotion');
  }
  const sourceRef = parseJsonObject(current.sourceRefJson);
  if (
    currentSource.source !== 'dreaming' ||
    sourceRef.promoted_by !== 'dreaming'
  ) {
    throw new Error('only dreaming-promoted memory can be demoted');
  }
  const timestamp = nowIso();
  const [demoted] = await input.db
    .update(pgSchema.memoryItemsPostgres)
    .set({
      status: 'demoted',
      sourceRefJson: {
        ...sourceRef,
        demoted_at: timestamp,
        demoted_by: input.actorId ?? null,
        demotion_reason: input.reason ?? null,
      },
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(pgSchema.memoryItemsPostgres.id, current.id),
        eq(pgSchema.memoryItemsPostgres.status, 'active'),
        input.expectedVersion === undefined
          ? undefined
          : sql`(${pgSchema.memoryItemsPostgres.sourceRefJson}->>'version')::int = ${input.expectedVersion}`,
      ),
    )
    .returning({ id: pgSchema.memoryItemsPostgres.id });
  if (!demoted) throw new Error('stale memory demotion');
  return { demoted: true };
}

export type OwnedMemoryItemLookupInput = {
  id: string;
} & Partial<MemoryBoundaryContext>;

const patternCandidatesTable = pgSchema.patternCandidatesPostgres;

/**
 * The pattern-candidate detection pass, run inside the dreaming deep phase.
 * Detects repeated work (pure heuristic) and upserts candidates by signature.
 * It only writes `detected` candidates — it never creates, edits, or proposes a
 * skill. Returns the number of candidates upserted.
 */
export async function detectAndUpsertPatternCandidates(input: {
  db: Db;
  subject: PatternCandidateSubject;
  transcriptTurns: PatternTranscriptTurn[];
  windowStart: string;
  windowEnd: string;
  nowIso: string;
}): Promise<number> {
  const drafts = detectPatternCandidates({
    transcriptTurns: input.transcriptTurns,
  });
  // Reset a snoozed candidate to detected only when its snooze elapsed or it
  // intensified; never resurrect a dismissed or accepted one. Evaluated against
  // the OLD row inside the atomic upsert.
  const resetSnooze = sql`${patternCandidatesTable.candidateStatus} = 'snoozed' and (${patternCandidatesTable.snoozedUntil} <= ${input.nowIso} or excluded.occurrences - ${patternCandidatesTable.occurrences} >= ${PATTERN_INTENSIFY_DELTA})`;
  for (const draft of drafts) {
    await input.db
      .insert(patternCandidatesTable)
      .values(buildDetectedRowValues(input.subject, draft, input))
      .onConflictDoUpdate({
        target: [
          patternCandidatesTable.appId,
          patternCandidatesTable.agentId,
          patternCandidatesTable.subjectType,
          patternCandidatesTable.subjectId,
          patternCandidatesTable.signature,
        ],
        set: {
          occurrences: sql`excluded.occurrences`,
          windowEnd: sql`excluded.window_end`,
          lastDetectedAt: sql`excluded.last_detected_at`,
          updatedAt: sql`case when ${patternCandidatesTable.candidateStatus} = 'suggested' and not (${resetSnooze}) then ${patternCandidatesTable.updatedAt} else excluded.updated_at end`,
          outcomeLabel: sql`excluded.outcome_label`,
          shortAsk: sql`excluded.short_ask`,
          evidenceRefsJson: sql`excluded.evidence_refs`,
          candidateStatus: sql`case when ${resetSnooze} then 'detected' else ${patternCandidatesTable.candidateStatus} end`,
          snoozedUntil: sql`case when ${resetSnooze} then null else ${patternCandidatesTable.snoozedUntil} end`,
        },
      });
  }
  return drafts.length;
}

/**
 * Pure row builder for a newly detected candidate. The id is derived from the
 * unique key so a re-detection maps to the same row (idempotent). Always
 * `detected` with no proposal — the batch path can never start a proposal (the
 * invariant). Exported for testing.
 */
export function buildDetectedRowValues(
  subject: PatternCandidateSubject,
  draft: PatternCandidateDraft,
  window: { windowStart: string; windowEnd: string; nowIso: string },
): typeof patternCandidatesTable.$inferInsert {
  return {
    id: `pc:${subject.appId}:${subject.agentId}:${subject.subjectType}:${subject.subjectId}:${draft.signature}`,
    appId: subject.appId,
    agentId: subject.agentId,
    folder: subject.folder,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    signature: draft.signature,
    outcomeLabel: draft.outcomeLabel,
    shortAsk: draft.shortAsk,
    occurrences: draft.occurrences,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    lastDetectedAt: window.nowIso,
    candidateStatus: 'detected',
    proposalStatus: null,
    snoozedUntil: null,
    evidenceRefsJson: draft.evidenceRefs,
    createdAt: window.nowIso,
    updatedAt: window.nowIso,
  };
}
