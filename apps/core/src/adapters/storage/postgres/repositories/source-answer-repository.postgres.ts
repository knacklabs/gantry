import { sourceChannelNativePersonId } from '../../../../memory/source-channel-memory-scope.js';
import { sourceChatModelAllowed } from '../../../../shared/source-chat-model-policy.js';
import { configureSourceChannelProfile } from './source-channel-profile.postgres.js';
import { lockSourceEventApp } from './source-channel-event-lock.postgres.js';
import { resolveModelSelectionForWorkload } from '../../../../shared/model-catalog.js';
import { and, eq, sql } from 'drizzle-orm';
import type {
  RequestSourceAnswer,
  RequestSourceAnswerResponse,
  SettleExecutionAuthority,
  SettleSourceHistory,
  SourceBinding,
} from '@gantry/contracts';
import * as s from '../schema/schema.js';
import { PostgresSourceChannelRepository } from './source-channel-repository.postgres.js';
import { SourceAnswerExecutionRepository } from './source-answer-execution.postgres.js';
import {
  type AnswerPayload,
  fail,
  hash,
  sameBinding,
} from './source-answer-base.postgres.js';
export type { PreparedSourceAnswer } from './source-answer-base.postgres.js';
export class PostgresSourceAnswerRepository extends SourceAnswerExecutionRepository {
  async configureProfile(
    appId: string,
    agentId: string,
    profile: NonNullable<RequestSourceAnswer['executionProfile']>,
    concurrency: number,
  ) {
    return configureSourceChannelProfile(
      this.db,
      appId,
      agentId,
      profile,
      concurrency,
    );
  }
  async request(
    appId: string,
    sessionId: string,
    request: RequestSourceAnswer,
  ): Promise<RequestSourceAnswerResponse> {
    if (
      request.authority.kind !== 'person' ||
      request.authority.subject !== request.requesterId
    )
      fail('Answer requester authority mismatch');
    if (
      Date.parse(request.authority.expiresAt) <= Date.now() ||
      Date.parse(request.deadlineAt) <= Date.now()
    )
      fail('Answer authority or deadline expired');
    const selectedModel = resolveModelSelectionForWorkload(
      request.model,
      'chat',
    );
    if (
      !selectedModel.ok ||
      !sourceChatModelAllowed(selectedModel.entry, appId)
    )
      fail(
        'Source answers require a configured alias for approved Claude Haiku 4.5',
      );
    return this.db.transaction(async (tx) => {
      await lockSourceEventApp(tx, appId);
      const session = await this.session(tx, appId, sessionId, request.binding);
      if (request.executionProfile) {
        const [agent] = await tx
          .select()
          .from(s.agentsPostgres)
          .where(
            and(
              eq(s.agentsPostgres.id, session.agentId),
              eq(s.agentsPostgres.appId, appId),
            ),
          );
        const [config] = await tx
          .select()
          .from(s.agentConfigVersionsPostgres)
          .where(
            eq(
              s.agentConfigVersionsPostgres.id,
              agent!.currentConfigVersionId!,
            ),
          );
        const limits = JSON.parse(config!.runtimeLimitsJson) as {
          metadata?: { sourceChannelProfileHash?: string };
        };
        if (
          limits.metadata?.sourceChannelProfileHash !==
          hash(request.executionProfile)
        )
          fail(
            'Source execution profile was not provisioned for this app agent',
          );
      }
      const id = `source-answer:${appId}:${request.attemptId}`;
      const [existing] = await tx
        .select()
        .from(s.pendingInteractionsPostgres)
        .where(eq(s.pendingInteractionsPostgres.id, id));
      if (existing) {
        const payload = existing.payloadJson as AnswerPayload;
        if (payload.requestHash !== hash(request))
          fail('Answer attempt identity conflicts');
        return this.receipt(payload, true);
      }
      const [question] = await tx
        .select()
        .from(s.messagesPostgres)
        .where(
          and(
            eq(s.messagesPostgres.conversationId, session.conversationId),
            eq(s.messagesPostgres.sourceGeneration, request.binding.generation),
            eq(s.messagesPostgres.sourceMessageId, request.questionSourceId),
          ),
        );
      if (
        !question ||
        question.direction !== 'inbound' ||
        String(question.sourcePosition) !== request.sourceCutoff
      )
        fail('Question must be a stored source question at the frozen cutoff');
      const active = await tx
        .select({ payload: s.pendingInteractionsPostgres.payloadJson })
        .from(s.pendingInteractionsPostgres)
        .where(
          and(
            eq(s.pendingInteractionsPostgres.appId, appId),
            eq(s.pendingInteractionsPostgres.status, 'pending'),
            eq(
              s.pendingInteractionsPostgres.sourceAgentFolder,
              session.agentId,
            ),
            sql`${s.pendingInteractionsPostgres.payloadJson}->>'interactionType' = 'source_answer'`,
          ),
        );
      const requests = active.map(
        (row) => (row.payload as AnswerPayload).request,
      );
      if (
        requests.filter(
          (row) => row.binding.discussionId === request.binding.discussionId,
        ).length >= 10
      )
        fail('Discussion pending answer limit reached');
      if (
        requests.filter((row) => row.requesterId === request.requesterId)
          .length >= 5
      )
        fail('Person pending answer limit reached');
      if (requests.some((row) => row.answerGoalId === request.answerGoalId))
        fail('Answer goal already has an active attempt');
      const [event] = await tx
        .insert(s.runtimeEventsPostgres)
        .values({
          appId,
          sessionId,
          agentId: session.agentId,
          conversationId: session.conversationId,
          eventType: 'source.answer.accepted',
          actor: 'sdk',
          correlationId: request.answerGoalId,
          payloadJson: JSON.stringify({
            attemptId: request.attemptId,
            answerGoalId: request.answerGoalId,
            questionMessageId: question.id,
          }),
        })
        .returning();
      const payload: AnswerPayload = {
        interactionType: 'source_answer',
        request,
        requestHash: hash(request),
        state: 'preparing',
        acceptedEventId: String(event!.eventId),
        questionMessageId: question.id,
      };
      await tx.insert(s.pendingInteractionsPostgres).values({
        id,
        appId,
        sourceAgentFolder: session.agentId,
        requestId: request.attemptId,
        kind: 'question',
        status: 'pending',
        payloadJson: payload,
        idempotencyKey: id,
        createdAt: new Date().toISOString(),
        expiresAt: request.deadlineAt,
      });
      await this.interaction(
        tx,
        session,
        id,
        request,
        `authority:${id}`,
        'execution_authority',
        { phase: 'admission' },
      );
      await this.historyIfNeeded(tx, session, id, request);
      return this.receipt(payload, false);
    });
  }
  async settleAuthority(
    appId: string,
    sessionId: string,
    input: SettleExecutionAuthority,
  ) {
    return this.db.transaction(async (tx) => {
      await lockSourceEventApp(tx, appId);
      const session = await this.session(tx, appId, sessionId, input.binding);
      const row = await this.settleInteraction(
        tx,
        appId,
        input.interactionId,
        input.idempotencyKey,
        input,
        'execution_authority',
      );
      const data = row.payloadJson as {
        parentAnswerId: string;
        request: { answerGoalId: string; attemptId: string };
      };
      if (
        data.request.answerGoalId !== input.answerGoalId ||
        data.request.attemptId !== input.attemptId
      )
        fail('Authority answer correlation mismatch');
      if (!input.allowed || Date.parse(input.expiresAt) <= Date.now())
        await this.finish(
          tx,
          appId,
          data.parentAnswerId,
          'canceled',
          'Current authority denied',
        );
      else {
        const [parent] = await tx
          .select()
          .from(s.pendingInteractionsPostgres)
          .where(
            and(
              eq(s.pendingInteractionsPostgres.appId, appId),
              eq(s.pendingInteractionsPostgres.id, data.parentAnswerId),
            ),
          );
        const requester = (parent?.payloadJson as AnswerPayload | undefined)
          ?.request.requesterId;
        if (!requester) fail('Source requester absent');
        await tx
          .insert(s.usersPostgres)
          .values({
            id: sourceChannelNativePersonId(appId, requester!),
            appId,
            kind: 'human',
            status: 'active',
          })
          .onConflictDoNothing();
        await this.admitIfReady(tx, session, data.parentAnswerId);
      }
      return { accepted: true as const, replayed: row.status === 'resolved' };
    });
  }
  async settleHistory(
    appId: string,
    sessionId: string,
    input: SettleSourceHistory,
  ) {
    // Source writes are independently durable and replayable. A crash before
    // settlement replays the same exact source identities without duplicates.
    const [pending] = await this.db
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(
        and(
          eq(s.pendingInteractionsPostgres.id, input.interactionId),
          eq(s.pendingInteractionsPostgres.appId, appId),
        ),
      );
    if (!pending) fail('History interaction not found');
    if (pending!.status === 'resolved') {
      const saved = pending!.resolutionJson as {
        idempotencyKey: string;
        hash: string;
      };
      if (
        saved.idempotencyKey !== input.idempotencyKey ||
        saved.hash !== hash(input)
      )
        fail('History settlement replay conflicts');
      return { accepted: true as const, replayed: true };
    }
    if (
      pending!.status !== 'pending' ||
      Date.parse(pending!.expiresAt) <= Date.now()
    )
      fail('History interaction expired');

    const data = pending!.payloadJson as {
      parentAnswerId: string;
      request: {
        binding: SourceBinding;
        sourceCutoff: string;
        afterPosition: string;
        sourceVersion: string;
        byteLimit: number;
        pageLimit: number;
        missingSourceIds: string[];
      };
    };
    if (
      !sameBinding(data.request.binding, input.binding) ||
      data.request.sourceVersion !== input.sourceVersion
    )
      fail('History generation or source version mismatch');
    if (input.messages.length > (data.request.pageLimit ?? 50))
      fail('History page exceeds requested record limit');
    if (
      input.status === 'ok' &&
      input.hasMore &&
      input.returnedThrough === data.request.afterPosition
    )
      fail('History page did not advance');
    let previous = BigInt(data.request.afterPosition);
    let bytes = 0;
    for (const row of input.messages) {
      if (
        (data.request.missingSourceIds?.length
          ? !data.request.missingSourceIds.includes(row.sourceMessageId) ||
            BigInt(row.sourcePosition) <= previous
          : BigInt(row.sourcePosition) !== previous + 1n) ||
        BigInt(row.sourcePosition) > BigInt(data.request.sourceCutoff)
      )
        fail('History page is not the exact ordered requested range');
      previous = BigInt(row.sourcePosition);
      bytes += Buffer.byteLength(JSON.stringify(row));
    }
    if (
      bytes > data.request.byteLimit ||
      String(previous) !== input.returnedThrough
    )
      fail('History boundaries or byte limit mismatch');
    if (input.status !== 'ok' && input.messages.length)
      fail('Failed history settlement contains source records');
    const [session] = await this.db
      .select()
      .from(s.controlHttpSessionsPostgres)
      .where(
        and(
          eq(s.controlHttpSessionsPostgres.sessionId, sessionId),
          eq(s.controlHttpSessionsPostgres.appId, appId),
        ),
      );
    if (!session) fail('Session not found');
    const service = (
      session!.externalRefJson as {
        sourceAuthority: { authorityId: string; subject: string };
      }
    ).sourceAuthority;
    for (const message of input.messages)
      await new PostgresSourceChannelRepository(this.db).append(
        appId,
        sessionId,
        {
          binding: input.binding,
          authority: {
            ...service,
            kind: 'service',
            authorityVersion: input.sourceVersion,
            expiresAt: pending!.expiresAt,
          },
          message,
          idempotencyKey: `history:${input.interactionId}:${message.sourceMessageId}`,
        },
      );
    return this.db.transaction(async (tx) => {
      await lockSourceEventApp(tx, appId);
      const session = await this.session(tx, appId, sessionId, input.binding);
      const row = await this.settleInteraction(
        tx,
        appId,
        input.interactionId,
        input.idempotencyKey,
        input,
        'source_history',
      );
      if (input.status !== 'ok')
        await this.finish(
          tx,
          appId,
          data.parentAnswerId,
          'failed',
          input.errorCode ?? input.status,
        );
      else {
        const [answer] = await tx
          .select()
          .from(s.pendingInteractionsPostgres)
          .where(eq(s.pendingInteractionsPostgres.id, data.parentAnswerId));
        const request = (answer!.payloadJson as AnswerPayload).request;
        if (
          data.request.missingSourceIds?.some(
            (sourceId) =>
              !input.messages.some(
                (message) => message.sourceMessageId === sourceId,
              ),
          )
        ) {
          await this.finish(
            tx,
            appId,
            data.parentAnswerId,
            'failed',
            'Required reply source record unavailable',
          );
          return { accepted: true as const, replayed: false };
        }
        const complete = await this.historyIfNeeded(
          tx,
          session,
          data.parentAnswerId,
          request,
        );
        if (!input.hasMore && !complete)
          await this.finish(
            tx,
            appId,
            data.parentAnswerId,
            'failed',
            'Incomplete source history',
          );
        else await this.admitIfReady(tx, session, data.parentAnswerId);
      }
      return { accepted: true as const, replayed: row.status === 'resolved' };
    });
  }
}
