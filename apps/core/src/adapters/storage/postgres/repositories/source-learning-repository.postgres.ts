import { assertSourceLearningRunPublication } from '../../../../memory/source-learning-activation.js';
import {
  parseItemSource,
  parseJsonObject,
} from '../../../../memory/app-memory-canonical-codec.js';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  SourceMessage,
  SettleExecutionAuthority,
} from '@gantry/contracts';
import type { NormalizedMemorySubject } from '../../../../memory/memory-types.js';
import { subjectIdFor } from '../../../../memory/app-memory-boundaries.js';
import type {
  SourceLearningScope,
  SourceLearningProposal,
  SourceLearningContext,
  SourceLearningCandidate,
} from '../../../../domain/ports/source-learning.js';
import {
  SourceAnswerRepositoryBase,
  type AnswerPayload,
  hash,
  fail,
} from './source-answer-base.postgres.js';
import { PostgresWorkerCoordinationRepository } from './worker-coordination-repository.postgres.js';
import { lockSourceEventApp } from './source-channel-event-lock.postgres.js';
import * as s from '../schema/schema.js';
export class PostgresSourceLearningRepository extends SourceAnswerRepositoryBase {
  async context(
    scope: SourceLearningScope,
    subject: NormalizedMemorySubject,
  ): Promise<SourceLearningContext> {
    const [answer] = await this.db
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(
        and(
          eq(s.pendingInteractionsPostgres.appId, scope.appId),
          eq(s.pendingInteractionsPostgres.runId, scope.runId),
          sql`${s.pendingInteractionsPostgres.payloadJson}->>'interactionType'='source_answer'`,
        ),
      );
    if (
      !answer ||
      answer.status !== 'pending' ||
      answer.sourceAgentFolder !== scope.agentId
    )
      fail('Learning requires the active source answer');
    const payload = answer!.payloadJson as AnswerPayload & {
      contextSnapshot?: { selectedSourceIds: string[] };
    };
    const request = payload.request;
    if (
      payload.state !== 'running' ||
      request.requesterId !== scope.personId ||
      request.binding.workspaceId !== scope.workspaceId
    )
      fail('Learning source scope mismatch');
    const [session] = await this.db
      .select()
      .from(s.controlHttpSessionsPostgres)
      .where(
        and(
          eq(s.controlHttpSessionsPostgres.appId, scope.appId),
          eq(
            s.controlHttpSessionsPostgres.externalConversationId,
            request.binding.discussionId,
          ),
          eq(s.controlHttpSessionsPostgres.agentId, scope.agentId),
          eq(
            sql<string>`${s.controlHttpSessionsPostgres.externalRefJson}->>'chatJid'`,
            scope.chatJid,
          ),
        ),
      );
    if (
      !session ||
      hash(
        (session.externalRefJson as Record<string, unknown>).sourceBinding,
      ) !== hash(request.binding)
    )
      fail('Learning generation was invalidated');
    const slots = await this.db
      .select()
      .from(s.runSlotsPostgres)
      .where(
        and(
          eq(s.runSlotsPostgres.holderId, answer!.runLeaseToken!),
          sql`${s.runSlotsPostgres.expiresAt}>now()`,
        ),
      );
    if (slots.length !== 2) fail('Learning source lease expired');
    const [run] = await this.db
      .select()
      .from(s.agentRunsPostgres)
      .where(
        and(
          eq(s.agentRunsPostgres.id, scope.runId),
          eq(s.agentRunsPostgres.appId, scope.appId),
        ),
      );
    if (!run || run.status !== 'running')
      fail('Learning source run is not active');
    return {
      answerId: answer!.id,
      sessionId: session!.sessionId,
      conversationId: session!.conversationId,
      claimToken: answer!.runLeaseToken!,
      request,
      scope,
      subject,
      deadlineAtMs: Math.min(
        Date.parse(request.deadlineAt),
        Date.parse(run!.startedAt ?? run!.createdAt) + 180000,
      ),
    };
  }
  async acquire(context: SourceLearningContext, holder: string) {
    return new PostgresWorkerCoordinationRepository(this.db).acquireRunSlot({
      slotKey: `source-learning:${context.scope.appId}:${context.scope.runId}`,
      holderId: holder,
      capacity: 1,
      ttlMs: 30000,
    });
  }
  async release(context: SourceLearningContext, holder: string) {
    await new PostgresWorkerCoordinationRepository(this.db).releaseRunSlot({
      slotKey: `source-learning:${context.scope.appId}:${context.scope.runId}`,
      holderId: holder,
    });
  }
  async stage(
    context: SourceLearningContext,
    proposal: SourceLearningProposal,
  ): Promise<SourceLearningCandidate> {
    const ids = [...new Set(proposal.supportingSourceIds)];
    if (
      ids.length !== proposal.supportingSourceIds.length ||
      !ids.length ||
      ids.length > 8 ||
      !ids.includes(context.request.questionSourceId)
    )
      fail('Learning needs current-question human source references');
    const [answer] = await this.db
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(eq(s.pendingInteractionsPostgres.id, context.answerId));
    const selected =
      (
        answer!.payloadJson as {
          contextSnapshot?: { selectedSourceIds?: string[] };
        }
      ).contextSnapshot?.selectedSourceIds ?? [];
    if (ids.some((id) => !selected.includes(id)))
      fail('Learning references omitted or unauthorized source history');
    const rows = await this.db
      .select({
        message: s.messagesPostgres,
        text: s.messagePartsPostgres.payloadJson,
      })
      .from(s.messagesPostgres)
      .innerJoin(
        s.messagePartsPostgres,
        and(
          eq(s.messagePartsPostgres.messageId, s.messagesPostgres.id),
          eq(s.messagePartsPostgres.ordinal, 0),
        ),
      )
      .where(
        and(
          eq(s.messagesPostgres.appId, context.scope.appId),
          eq(s.messagesPostgres.conversationId, context.conversationId),
          eq(
            s.messagesPostgres.sourceGeneration,
            context.request.binding.generation,
          ),
          inArray(s.messagesPostgres.sourceMessageId, ids),
        ),
      );
    const evidence = ids.map((id) => {
      const row = rows.find((row) => row.message.sourceMessageId === id);
      const source = (
        row?.message.externalRefJson as { source?: SourceMessage } | undefined
      )?.source;
      if (
        !row ||
        !source ||
        source.authorKind !== 'human' ||
        source.origin !== 'human' ||
        BigInt(source.sourcePosition) > BigInt(context.request.sourceCutoff)
      )
        fail('Learning support must be actual selected human messages');
      return {
        sourceMessageId: id,
        authorId: source!.authorId,
        text: String((row!.text as { text: string }).text),
        createdAt: source!.createdAt,
        revisionId: source!.revisionId,
      };
    });
    if (
      context.subject.subjectType === 'user' &&
      evidence.some((row) => row.authorId !== context.scope.personId)
    )
      fail('Personal learning requires requester-authored support');
    if (proposal.source === 'discussion-inferred' && evidence.length < 2)
      fail('Inferred learning requires repeated human corrections');
    if (Buffer.byteLength(JSON.stringify(evidence)) > 65536)
      fail('Learning evidence exceeds bounded validation context');
    const id = `source-learning:${hash([context.scope.appId, context.scope.runId, context.subject.subjectType, context.subject.subjectId, proposal])}`;
    const [existing] = await this.db
      .select()
      .from(s.memoryCandidatesPostgres)
      .where(eq(s.memoryCandidatesPostgres.id, id));
    if (existing) return { id, context, evidence, replayed: true };
    await this.db.transaction(async (tx) => {
      await tx
        .select()
        .from(s.pendingInteractionsPostgres)
        .where(eq(s.pendingInteractionsPostgres.id, context.answerId))
        .for('update');
      const count = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.memoryCandidatesPostgres)
        .where(
          and(
            eq(s.memoryCandidatesPostgres.appId, context.scope.appId),
            eq(
              sql<string>`${s.memoryCandidatesPostgres.metadataJson}::jsonb->>'sourceRunId'`,
              context.scope.runId,
            ),
          ),
        );
      if (count[0]!.n >= 4) fail('Source learning proposal limit reached');
      const evidenceIds: string[] = [];
      for (const row of evidence) {
        const eid = `source-evidence:${hash([context.scope.appId, context.scope.runId, subjectIdFor(context.subject), row.sourceMessageId])}`;
        evidenceIds.push(eid);
        await tx
          .insert(s.memoryEvidencePostgres)
          .values({
            id: eid,
            appId: context.scope.appId,
            agentId: context.scope.agentId,
            subjectType: context.subject.subjectType,
            subjectId: subjectIdFor(context.subject),
            sourceType: 'message',
            sourceId: row.sourceMessageId,
            actorId: row.authorId,
            text: row.text,
            metadataJson: JSON.stringify({
              discussionId: context.request.binding.discussionId,
              generation: context.request.binding.generation,
              revisionId: row.revisionId,
              sourceCreatedAt: row.createdAt,
            }),
            createdAt: new Date().toISOString(),
          })
          .onConflictDoNothing();
      }
      await tx
        .insert(s.memoryCandidatesPostgres)
        .values({
          id,
          appId: context.scope.appId,
          agentId: context.scope.agentId,
          subjectType: context.subject.subjectType,
          subjectId: subjectIdFor(context.subject),
          kind: proposal.kind,
          key: proposal.key,
          value: proposal.value,
          reason: proposal.why ?? null,
          evidenceIdsJson: JSON.stringify(evidenceIds),
          status: 'validating',
          metadataJson: JSON.stringify({
            answerId: context.answerId,
            sourceRunId: context.scope.runId,
            claimToken: context.claimToken,
            binding: context.request.binding,
            personId: context.scope.personId,
            source: proposal.source,
            proposalHash: hash(proposal),
          }),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .onConflictDoNothing();
    });
    return { id, context, evidence, replayed: false };
  }
  async forget(
    context: SourceLearningContext,
    id: string,
    expectedVersion: number | undefined,
    authorityId: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(s.memoryItemsPostgres)
        .where(
          and(
            eq(s.memoryItemsPostgres.id, id),
            eq(s.memoryItemsPostgres.appId, context.scope.appId),
            eq(s.memoryItemsPostgres.agentId, context.scope.agentId),
            eq(s.memoryItemsPostgres.subjectType, context.subject.subjectType),
            eq(s.memoryItemsPostgres.subjectId, subjectIdFor(context.subject)),
          ),
        );
      if (!current)
        throw new Error('Source memory is outside the current scope');
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['source-learning', subjectIdFor(context.subject), current.key])},0))`,
      );
      await assertSourceLearningRunPublication(
        tx,
        context.subject,
        {
          answerId: context.answerId,
          sourceRunId: context.scope.runId,
          claimToken: context.claimToken,
          binding: context.request.binding,
        },
        authorityId,
      );
      const [locked] = await tx
        .select()
        .from(s.memoryItemsPostgres)
        .where(eq(s.memoryItemsPostgres.id, id))
        .for('update');
      const source = parseItemSource(locked!);
      if (expectedVersion === undefined || source.version !== expectedVersion)
        throw new Error('Stale source memory forget; read its current version');
      if (
        !['discussion-explicit', 'discussion-inferred'].includes(source.source)
      )
        throw new Error('Only source learning can be forgotten here');
      if (locked!.status === 'deleted') return { demoted: true };
      if (locked!.status !== 'active')
        throw new Error('Source memory is no longer active');
      await tx
        .update(s.memoryItemsPostgres)
        .set({
          status: 'deleted',
          updatedAt: new Date().toISOString(),
          sourceRefJson: {
            ...parseJsonObject(locked!.sourceRefJson),
            version: source.version + 1,
            forgottenBy: context.scope.personId,
            forgottenInRun: context.scope.runId,
          },
        })
        .where(eq(s.memoryItemsPostgres.id, id));
      return { demoted: true };
    });
  }
  async audit(id: string, details: Record<string, unknown>) {
    const row = await this.read(id);
    if (row)
      await this.db
        .update(s.memoryCandidatesPostgres)
        .set({
          metadataJson: JSON.stringify({
            ...JSON.parse(row.metadataJson),
            ...details,
          }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(s.memoryCandidatesPostgres.id, id));
  }
  async read(id: string) {
    const [row] = await this.db
      .select()
      .from(s.memoryCandidatesPostgres)
      .where(eq(s.memoryCandidatesPostgres.id, id));
    return row;
  }
  async decision(
    id: string,
    allowed: boolean,
    details: Record<string, unknown>,
  ) {
    const row = await this.read(id);
    if (!row) fail('Learning candidate absent');
    await this.db
      .update(s.memoryCandidatesPostgres)
      .set({
        status: allowed ? 'validated' : 'rejected',
        metadataJson: JSON.stringify({
          ...JSON.parse(row!.metadataJson),
          ...details,
          validatedAt: new Date().toISOString(),
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(s.memoryCandidatesPostgres.id, id));
  }
  async authorize(
    candidate: SourceLearningCandidate,
    phase: 'evidence' | 'publication',
    deadline: number,
  ): Promise<string> {
    const id = `learning-authority:${hash([candidate.id, phase, randomUUID()])}`;
    await this.db.transaction(async (tx) => {
      await lockSourceEventApp(tx, candidate.context.scope.appId);
      const session = await this.session(
        tx,
        candidate.context.scope.appId,
        candidate.context.sessionId,
        candidate.context.request.binding,
      );
      await this.interaction(
        tx,
        session,
        candidate.context.answerId,
        candidate.context.request,
        id,
        'execution_authority',
        { phase },
      );
    });
    while (Date.now() < deadline) {
      const [row] = await this.db
        .select()
        .from(s.pendingInteractionsPostgres)
        .where(eq(s.pendingInteractionsPostgres.id, id));
      if (row?.status === 'resolved') {
        const grant = (
          row.resolutionJson as { result?: SettleExecutionAuthority } | null
        )?.result;
        if (
          !grant?.allowed ||
          Date.parse(grant.expiresAt) <= Date.now() ||
          Date.parse(grant.expiresAt) > Date.now() + 5500
        )
          fail('Fresh learning authority was denied or expired');
        return id;
      }
      if (row?.status === 'cancelled') fail('Learning authority was canceled');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return fail('Fresh learning authority timed out');
  }
}
