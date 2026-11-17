import { and, eq, sql } from 'drizzle-orm';
import * as s from '../adapters/storage/postgres/schema/schema.js';
import type { CanonicalExecutor } from '../adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import { hash } from '../adapters/storage/postgres/repositories/source-answer-base.postgres.js';
import type {
  SaveAppMemoryInput,
  NormalizedMemorySubject,
} from './memory-types.js';
import { subjectIdFor } from './app-memory-boundaries.js';
import {
  parseItemSource,
  parseItemValue,
} from './app-memory-canonical-codec.js';
export async function assertSourceLearningActivation(
  tx: CanonicalExecutor,
  input: SaveAppMemoryInput,
  subject: NormalizedMemorySubject,
) {
  if (!input.sourceLearningCandidateId) return;
  const [candidate] = await tx
    .select()
    .from(s.memoryCandidatesPostgres)
    .where(eq(s.memoryCandidatesPostgres.id, input.sourceLearningCandidateId))
    .for('update');
  if (
    !candidate ||
    candidate.appId !== subject.appId ||
    candidate.agentId !== subject.agentId ||
    candidate.subjectType !== subject.subjectType ||
    candidate.subjectId !== subjectIdFor(subject) ||
    candidate.key !== input.key.trim() ||
    candidate.value !== input.value.trim() ||
    candidate.kind !== input.kind ||
    !['validated', 'active'].includes(candidate.status)
  )
    throw new Error(
      'Source learning validation proof does not match this write',
    );
  const meta = JSON.parse(candidate.metadataJson) as {
    answerId: string;
    sourceRunId: string;
    claimToken: string;
    binding: Record<string, unknown>;
    activatedMemoryId?: string;
    activatedVersion?: number;
  };
  await assertSourceLearningRunPublication(
    tx,
    subject,
    meta,
    input.sourceLearningAuthorityId,
  );
  if (candidate.status === 'active') {
    const [memory] = meta.activatedMemoryId
      ? await tx
          .select()
          .from(s.memoryItemsPostgres)
          .where(eq(s.memoryItemsPostgres.id, meta.activatedMemoryId))
      : [];
    if (
      !memory ||
      memory.status !== 'active' ||
      parseItemValue(memory).value !== candidate.value ||
      parseItemSource(memory).version !== meta.activatedVersion
    )
      throw new Error(
        'Previously activated learning was replaced or forgotten; fresh human support is required',
      );
    return { candidate, existing: memory };
  }
  // A forgotten value is not revived by replaying old human evidence.
  const retired = await tx
    .select()
    .from(s.memoryItemsPostgres)
    .where(
      and(
        eq(s.memoryItemsPostgres.appId, subject.appId),
        eq(s.memoryItemsPostgres.agentId, subject.agentId),
        eq(s.memoryItemsPostgres.subjectId, subjectIdFor(subject)),
        eq(s.memoryItemsPostgres.key, input.key.trim()),
        sql`${s.memoryItemsPostgres.status}<>'active'`,
      ),
    )
    .orderBy(sql`${s.memoryItemsPostgres.updatedAt} DESC`)
    .limit(1);
  if (retired[0]) {
    const evidenceIds = JSON.parse(candidate.evidenceIdsJson) as string[];
    const evidence = await tx
      .select()
      .from(s.memoryEvidencePostgres)
      .where(sql`${s.memoryEvidencePostgres.id} = ANY(${evidenceIds}::text[])`);
    const latest = Math.max(
      ...evidence.map((row) =>
        Date.parse(
          (JSON.parse(row.metadataJson) as { sourceCreatedAt?: string })
            .sourceCreatedAt ?? '1970-01-01',
        ),
      ),
    );
    if (latest <= Date.parse(retired[0].updatedAt))
      throw new Error('Forgotten learning requires fresh human support');
  }
  return { candidate };
}
export async function recordSourceLearningActivation(
  tx: CanonicalExecutor,
  candidate: typeof s.memoryCandidatesPostgres.$inferSelect | undefined,
  memory: typeof s.memoryItemsPostgres.$inferSelect,
) {
  if (!candidate) return;
  await tx
    .update(s.memoryCandidatesPostgres)
    .set({
      status: 'active',
      updatedAt: new Date().toISOString(),
      metadataJson: JSON.stringify({
        ...JSON.parse(candidate.metadataJson),
        activatedMemoryId: memory.id,
        activatedVersion: parseItemSource(memory).version,
        activatedAt: new Date().toISOString(),
      }),
    })
    .where(eq(s.memoryCandidatesPostgres.id, candidate.id));
}

export async function assertSourceLearningRunPublication(
  tx: CanonicalExecutor,
  subject: NormalizedMemorySubject,
  meta: {
    answerId: string;
    sourceRunId: string;
    claimToken: string;
    binding: Record<string, unknown>;
  },
  authorityId: string | undefined,
) {
  const [answer] = await tx
    .select()
    .from(s.pendingInteractionsPostgres)
    .where(
      and(
        eq(s.pendingInteractionsPostgres.id, meta.answerId),
        eq(s.pendingInteractionsPostgres.appId, subject.appId),
      ),
    )
    .for('update');
  if (
    !answer ||
    answer.status !== 'pending' ||
    answer.runId !== meta.sourceRunId ||
    answer.runLeaseToken !== meta.claimToken ||
    (answer.payloadJson as { state?: string }).state !== 'running'
  )
    throw new Error('Source learning answer was fenced');
  const [session] = await tx
    .select()
    .from(s.controlHttpSessionsPostgres)
    .where(
      and(
        eq(s.controlHttpSessionsPostgres.appId, subject.appId),
        eq(
          s.controlHttpSessionsPostgres.externalConversationId,
          String(meta.binding.discussionId),
        ),
      ),
    );
  if (
    !session ||
    hash((session.externalRefJson as Record<string, unknown>).sourceBinding) !==
      hash(meta.binding)
  )
    throw new Error('Source learning generation was invalidated');
  const slots = await tx
    .select()
    .from(s.runSlotsPostgres)
    .where(
      and(
        eq(s.runSlotsPostgres.holderId, meta.claimToken),
        sql`${s.runSlotsPostgres.expiresAt}>now()`,
      ),
    );
  if (slots.length !== 2) throw new Error('Source learning lease expired');
  const [authority] = authorityId
    ? await tx
        .select()
        .from(s.pendingInteractionsPostgres)
        .where(eq(s.pendingInteractionsPostgres.id, authorityId))
    : [];
  const request = authority?.payloadJson as
    | { parentAnswerId?: string; request?: { phase?: string } }
    | undefined;
  const grant = (
    authority?.resolutionJson as {
      result?: { allowed: boolean; expiresAt: string };
    } | null
  )?.result;
  if (
    authority?.appId !== subject.appId ||
    authority.status !== 'resolved' ||
    request?.parentAnswerId !== meta.answerId ||
    request.request?.phase !== 'publication' ||
    !grant?.allowed ||
    Date.parse(grant.expiresAt) <= Date.now() ||
    Date.parse(grant.expiresAt) > Date.now() + 5500
  )
    throw new Error('Fresh source learning publication authority is required');
}
