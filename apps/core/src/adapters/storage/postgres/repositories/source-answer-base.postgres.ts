import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type {
  RequestSourceAnswer,
  RequestSourceAnswerResponse,
  SourceBinding,
} from '@gantry/contracts';
import * as s from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import { ApplicationError } from '../../../../application/common/application-error.js';
import { enqueueLiveAdmissionWorkItemWithExecutor } from './live-admission-work-item-repository.postgres.js';
import { makeAgentThreadQueueKey } from '../../../../shared/thread-queue-key.js';
import type { NewMessage } from '../../../../domain/types.js';
export interface PreparedSourceAnswer {
  id: string;
  request: RequestSourceAnswer;
  messages: NewMessage[];
  selectedSourceIds: string[];
  claimToken: string;
}
export const fail = (message: string): never => {
  throw new ApplicationError('CONFLICT', message);
};
export const stable = (value: unknown): string =>
  Array.isArray(value)
    ? '[' + value.map(stable).join(',') + ']'
    : value && typeof value === 'object'
      ? '{' +
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => JSON.stringify(key) + ':' + stable(item))
          .join(',') +
        '}'
      : JSON.stringify(value);
export const hash = (value: unknown) =>
  createHash('sha256').update(stable(value)).digest('hex');
export const sameBinding = (a: SourceBinding, b: SourceBinding) =>
  a.discussionId === b.discussionId &&
  a.generation === b.generation &&
  a.workspaceId === b.workspaceId &&
  a.tenderId === b.tenderId;
export type AnswerPayload = {
  interactionType: 'source_answer';
  request: RequestSourceAnswer;
  requestHash: string;
  state: RequestSourceAnswerResponse['state'];
  acceptedEventId: string;
  questionMessageId: string;
};
export class SourceAnswerRepositoryBase {
  constructor(protected readonly db: CanonicalDb) {}
  protected async session(
    tx: CanonicalExecutor,
    appId: string,
    sessionId: string,
    binding: SourceBinding,
  ) {
    const [session] = await tx
      .select()
      .from(s.controlHttpSessionsPostgres)
      .where(
        and(
          eq(s.controlHttpSessionsPostgres.sessionId, sessionId),
          eq(s.controlHttpSessionsPostgres.appId, appId),
        ),
      )
      .for('update');
    const ref = session?.externalRefJson as
      | { sourceBinding?: SourceBinding }
      | undefined;
    if (
      !session ||
      !ref?.sourceBinding ||
      !sameBinding(ref.sourceBinding, binding)
    )
      fail('Untrusted source discussion binding');
    const [agent] = await tx
      .select()
      .from(s.agentSessionsPostgres)
      .where(eq(s.agentSessionsPostgres.id, sessionId));
    if (agent?.status === 'archived') fail('Source discussion archived');
    return session!;
  }
  protected async interaction(
    tx: CanonicalExecutor,
    session: typeof s.controlHttpSessionsPostgres.$inferSelect,
    parentAnswerId: string,
    request: RequestSourceAnswer,
    id: string,
    type: 'source_history' | 'execution_authority',
    extra: Record<string, unknown>,
  ) {
    const payload = {
      interactionType: type,
      interactionId: id,
      binding: request.binding,
      authority: request.authority,
      answerGoalId: request.answerGoalId,
      attemptId: request.attemptId,
      ...extra,
    };
    const inserted = await tx
      .insert(s.pendingInteractionsPostgres)
      .values({
        id,
        appId: session.appId,
        sourceAgentFolder: session.agentId,
        requestId: id,
        kind: 'question',
        status: 'pending',
        payloadJson: { parentAnswerId, request: payload },
        idempotencyKey: id,
        createdAt: new Date().toISOString(),
        expiresAt: request.deadlineAt,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length)
      await tx.insert(s.runtimeEventsPostgres).values({
        appId: session.appId,
        sessionId: session.sessionId,
        agentId: session.agentId,
        conversationId: session.conversationId,
        eventType: 'interaction.pending',
        actor: 'system',
        correlationId: request.answerGoalId,
        payloadJson: JSON.stringify(payload),
      });
  }
  protected async historyIfNeeded(
    tx: CanonicalExecutor,
    session: typeof s.controlHttpSessionsPostgres.$inferSelect,
    id: string,
    request: RequestSourceAnswer,
  ) {
    const through = String(
      (session.externalRefJson as Record<string, unknown>)
        .sourceContiguousPosition ?? '0',
    );
    if (BigInt(through) >= BigInt(request.sourceCutoff)) return true;
    await this.interaction(
      tx,
      session,
      id,
      request,
      `history:${id}:${through}`,
      'source_history',
      {
        sourceCutoff: request.sourceCutoff,
        afterPosition: through,
        missingSourceIds: [],
        pageLimit: 50,
        byteLimit: 262144,
        sourceVersion: request.revisionId,
      },
    );
    return false;
  }
  protected async settleInteraction(
    tx: CanonicalExecutor,
    appId: string,
    id: string,
    idempotencyKey: string,
    resolution: unknown,
    type: string,
  ) {
    const [row] = await tx
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(
        and(
          eq(s.pendingInteractionsPostgres.id, id),
          eq(s.pendingInteractionsPostgres.appId, appId),
        ),
      )
      .for('update');
    if (
      !row ||
      (row.payloadJson as { request: { interactionType: string } }).request
        .interactionType !== type
    )
      fail('Interaction not found');
    if (row!.status === 'resolved') {
      const saved = row!.resolutionJson as {
        idempotencyKey: string;
        hash: string;
      };
      if (
        saved.idempotencyKey !== idempotencyKey ||
        saved.hash !== hash(resolution)
      )
        fail('Settlement conflict');
      return row!;
    }
    if (row!.status !== 'pending' || Date.parse(row!.expiresAt) <= Date.now())
      fail('Interaction expired');
    await tx
      .update(s.pendingInteractionsPostgres)
      .set({
        status: 'resolved',
        resolutionJson: {
          idempotencyKey,
          hash: hash(resolution),
          result: resolution,
        },
        resolvedAt: new Date().toISOString(),
      })
      .where(eq(s.pendingInteractionsPostgres.id, id));
    return row!;
  }
  protected async admitIfReady(
    tx: CanonicalExecutor,
    session: typeof s.controlHttpSessionsPostgres.$inferSelect,
    id: string,
  ) {
    const [answer] = await tx
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(eq(s.pendingInteractionsPostgres.id, id));
    if (!answer || answer.status !== 'pending') return;
    const payload = answer.payloadJson as AnswerPayload;
    const request = payload.request;
    if (payload.state !== 'preparing') return;
    if (Date.parse(request.deadlineAt) <= Date.now()) {
      await this.finish(
        tx,
        session.appId,
        id,
        'failed',
        'Answer admission deadline expired',
      );
      return;
    }
    const [authority] = await tx
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(eq(s.pendingInteractionsPostgres.id, `authority:${id}`));
    if (authority?.status !== 'resolved') return;
    if (!(await this.historyIfNeeded(tx, session, id, request))) return;
    const queueJid = makeAgentThreadQueueKey(
      `app:${session.appId}:${request.binding.discussionId}`,
      session.agentId,
      null,
      `control:${session.appId}`,
    );
    const admission = await enqueueLiveAdmissionWorkItemWithExecutor(
      tx,
      {
        id: `admission:${id}`,
        appId: session.appId,
        agentId: session.agentId,
        agentSessionId: session.sessionId,
        conversationId: `app:${session.appId}:${request.binding.discussionId}`,
        threadId: null,
        queueJid,
        messageId: payload.questionMessageId,
        messageCursor: request.sourceCutoff,
        senderUserId: request.requesterId,
        idempotencyKey: `admission:${id}`,
        triggerDecision: { source: 'source_answer', answerId: id },
      },
      100,
    );
    if (admission.outcome === 'overloaded')
      fail('Native answer pool backlog full');
    await tx
      .update(s.pendingInteractionsPostgres)
      .set({ payloadJson: { ...payload, state: 'queued' } })
      .where(eq(s.pendingInteractionsPostgres.id, id));
  }
  protected async finish(
    tx: CanonicalExecutor,
    appId: string,
    id: string,
    state: 'failed' | 'canceled',
    error: string,
  ) {
    const [answer] = await tx
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(eq(s.pendingInteractionsPostgres.id, id));
    if (!answer) return;
    const payload = answer.payloadJson as AnswerPayload;
    await tx
      .update(s.pendingInteractionsPostgres)
      .set({
        status: 'cancelled',
        payloadJson: { ...payload, state, error },
        resolvedAt: new Date().toISOString(),
      })
      .where(eq(s.pendingInteractionsPostgres.id, id));
    await tx.insert(s.runtimeEventsPostgres).values({
      appId,
      eventType: `source.answer.${state}`,
      actor: 'system',
      correlationId: payload.request.answerGoalId,
      payloadJson: JSON.stringify({
        attemptId: payload.request.attemptId,
        error,
      }),
    });
  }
  protected receipt(
    payload: AnswerPayload,
    replayed: boolean,
  ): RequestSourceAnswerResponse {
    return {
      accepted: true,
      replayed,
      answerGoalId: payload.request.answerGoalId,
      attemptId: payload.request.attemptId,
      questionMessageId: payload.questionMessageId,
      acceptedEventId: payload.acceptedEventId,
      state: payload.state,
    };
  }
}
