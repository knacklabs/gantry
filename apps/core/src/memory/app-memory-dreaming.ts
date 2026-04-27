import { randomUUID, createHash } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type {
  AppMemoryItem,
  DreamDecisionAction,
  DreamingRunStatus,
  MemoryKind,
  NormalizedMemorySubject,
  SaveAppMemoryInput,
} from './memory-types.js';

type Db = NodePgDatabase<typeof pgSchema>;
type MemoryItemRow = typeof pgSchema.memoryItemsPostgres.$inferSelect;

function nowIso(): string {
  return new Date().toISOString();
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseJsonObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function recordDreamDecision(input: {
  db: Db;
  runId: string;
  subject: NormalizedMemorySubject;
  action: DreamDecisionAction;
  rationale: string;
  itemId?: string;
  candidateId?: string;
  evidenceIds?: string[];
  applied: boolean;
}): Promise<void> {
  await input.db.insert(pgSchema.memoryDreamDecisionsPostgres).values({
    id: `mdd_${randomUUID().replace(/-/g, '')}`,
    runId: input.runId,
    appId: input.subject.appId,
    agentId: input.subject.agentId,
    itemId: input.itemId ?? null,
    candidateId: input.candidateId ?? null,
    action: input.action,
    rationale: input.rationale,
    evidenceIdsJson: JSON.stringify(input.evidenceIds || []),
    applied: input.applied,
    createdAt: nowIso(),
  });
}

export async function runAppMemoryDreamPass(input: {
  db: Db;
  runId: string;
  subject: NormalizedMemorySubject;
  phase: DreamingRunStatus['phase'];
  dryRun: boolean;
  listItems: () => Promise<Array<{ row: MemoryItemRow }>>;
  save: (value: SaveAppMemoryInput) => Promise<AppMemoryItem>;
}): Promise<Array<{ action: DreamDecisionAction }>> {
  const { db, runId, subject, phase, dryRun } = input;
  const decisions: Array<{ action: DreamDecisionAction }> = [];
  const recentEvidence = await db
    .select()
    .from(pgSchema.memoryEvidencePostgres)
    .where(
      and(
        eq(pgSchema.memoryEvidencePostgres.appId, subject.appId),
        eq(pgSchema.memoryEvidencePostgres.agentId, subject.agentId),
        eq(pgSchema.memoryEvidencePostgres.subjectType, subject.subjectType),
        eq(pgSchema.memoryEvidencePostgres.subjectId, subject.subjectId),
      ),
    )
    .orderBy(desc(pgSchema.memoryEvidencePostgres.createdAt))
    .limit(25);

  if (phase === 'light' || phase === 'all') {
    for (const evidence of recentEvidence.slice(0, 10)) {
      const key = `evidence:${hashText(evidence.text).slice(0, 16)}`;
      const candidateId = `mca_${hashText(`${subject.appId}:${subject.agentId}:${key}`).slice(0, 32)}`;
      await db
        .insert(pgSchema.memoryCandidatesPostgres)
        .values({
          id: candidateId,
          appId: subject.appId,
          agentId: subject.agentId,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          threadId: subject.threadId ?? null,
          kind: 'fact',
          key,
          value: evidence.text.slice(0, 1000),
          reason: 'Recent grounded evidence is available for memory review.',
          evidenceIdsJson: JSON.stringify([evidence.id]),
          confidence: 0.55,
          status: 'staged',
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
        .onConflictDoNothing();
      await recordDreamDecision({
        db,
        runId,
        subject,
        action: 'stage_candidate',
        candidateId,
        rationale:
          'Light dreaming staged recent evidence for promotion review.',
        evidenceIds: [evidence.id],
        applied: true,
      });
      decisions.push({ action: 'stage_candidate' });
    }
  }

  const items = await input.listItems();
  if (phase === 'rem' || phase === 'all') {
    for (const item of items) {
      const payload = parseJsonObject(item.row.valueJson);
      const value =
        typeof payload.value === 'string' ? payload.value.toLowerCase() : '';
      if (/\b(no longer|instead|actually|correction|wrong)\b/.test(value)) {
        await recordDreamDecision({
          db,
          runId,
          subject,
          action: 'needs_review',
          itemId: item.row.id,
          rationale:
            'REM dreaming found correction language; human or admin review should decide whether to rewrite or retire related memory.',
          applied: false,
        });
        decisions.push({ action: 'needs_review' });
      }
    }
  }

  if (phase === 'deep' || phase === 'all') {
    const candidates = await db
      .select()
      .from(pgSchema.memoryCandidatesPostgres)
      .where(
        and(
          eq(pgSchema.memoryCandidatesPostgres.appId, subject.appId),
          eq(pgSchema.memoryCandidatesPostgres.agentId, subject.agentId),
          eq(
            pgSchema.memoryCandidatesPostgres.subjectType,
            subject.subjectType,
          ),
          eq(pgSchema.memoryCandidatesPostgres.subjectId, subject.subjectId),
          eq(pgSchema.memoryCandidatesPostgres.status, 'staged'),
        ),
      )
      .orderBy(desc(pgSchema.memoryCandidatesPostgres.confidence))
      .limit(10);
    for (const candidate of candidates) {
      const evidenceIds = parseJsonArray(candidate.evidenceIdsJson);
      if (dryRun) {
        await recordDreamDecision({
          db,
          runId,
          subject,
          action: 'promote',
          candidateId: candidate.id,
          rationale: 'Deep dreaming would promote this grounded candidate.',
          evidenceIds,
          applied: false,
        });
        decisions.push({ action: 'promote' });
        continue;
      }
      const saved = await input.save({
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        userId: subject.userId,
        groupId: subject.groupId,
        channelId: subject.channelId,
        threadId: subject.threadId,
        kind: candidate.kind as MemoryKind,
        key: candidate.key,
        value: candidate.value,
        why: candidate.reason || undefined,
        confidence: Math.max(0.6, candidate.confidence),
        source: 'dreaming',
        evidenceIds,
        isAdminWrite: subject.subjectType === 'common',
      });
      await db
        .update(pgSchema.memoryCandidatesPostgres)
        .set({ status: 'promoted', updatedAt: nowIso() })
        .where(eq(pgSchema.memoryCandidatesPostgres.id, candidate.id));
      await recordDreamDecision({
        db,
        runId,
        subject,
        action: 'promote',
        itemId: saved.id,
        candidateId: candidate.id,
        rationale:
          'Deep dreaming promoted a grounded candidate into durable memory.',
        evidenceIds,
        applied: true,
      });
      decisions.push({ action: 'promote' });
    }
  }
  return decisions;
}
