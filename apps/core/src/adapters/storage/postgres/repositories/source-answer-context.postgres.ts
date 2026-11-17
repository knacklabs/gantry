import { lockSourceEventApp } from './source-channel-event-lock.postgres.js';
import { makeAgentThreadQueueKey } from '../../../../shared/thread-queue-key.js';
import { PostgresWorkerCoordinationRepository } from './worker-coordination-repository.postgres.js';
import { sourceChannelMemorySubject } from '../../../../memory/source-channel-memory-scope.js';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  SettleExecutionAuthority,
  SourceMessage,
} from '@gantry/contracts';
import * as s from '../schema/schema.js';
import type { NewMessage } from '../../../../domain/types.js';
import {
  SourceAnswerRepositoryBase,
  type PreparedSourceAnswer,
  type AnswerPayload,
  fail,
  hash,
} from './source-answer-base.postgres.js';
export class SourceAnswerContextRepository extends SourceAnswerRepositoryBase {
  async pendingQueueKeys() {
    const rows = await this.db
      .select({
        appId: s.pendingInteractionsPostgres.appId,
        payload: s.pendingInteractionsPostgres.payloadJson,
        agent: s.pendingInteractionsPostgres.sourceAgentFolder,
      })
      .from(s.pendingInteractionsPostgres)
      .where(
        and(
          eq(s.pendingInteractionsPostgres.status, 'pending'),
          sql`${s.pendingInteractionsPostgres.payloadJson}->>'interactionType' = 'source_answer'`,
          sql`${s.pendingInteractionsPostgres.payloadJson}->>'state' = 'queued'`,
        ),
      )
      .orderBy(asc(s.pendingInteractionsPostgres.createdAt))
      .limit(100);
    return rows.map((row) => {
      const request = (row.payload as AnswerPayload).request;
      return makeAgentThreadQueueKey(
        `app:${row.appId}:${request.binding.discussionId}`,
        row.agent,
        null,
        `control:${row.appId}`,
      );
    });
  }
  async hasQueued(appId: string, conversationJid: string) {
    const [session] = await this.db
      .select()
      .from(s.controlHttpSessionsPostgres)
      .where(
        and(
          eq(s.controlHttpSessionsPostgres.appId, appId),
          eq(
            sql<string>`${s.controlHttpSessionsPostgres.externalRefJson}->>'chatJid'`,
            conversationJid,
          ),
        ),
      );
    if (!session) return false;
    const [row] = await this.db
      .select({ id: s.pendingInteractionsPostgres.id })
      .from(s.pendingInteractionsPostgres)
      .where(
        and(
          eq(s.pendingInteractionsPostgres.appId, appId),
          eq(s.pendingInteractionsPostgres.status, 'pending'),
          eq(
            sql<string>`${s.pendingInteractionsPostgres.payloadJson}#>>'{request,binding,discussionId}'`,
            session.externalConversationId,
          ),
          sql`${s.pendingInteractionsPostgres.payloadJson}->>'interactionType' = 'source_answer'`,
          sql`${s.pendingInteractionsPostgres.payloadJson}->>'state' = 'queued'`,
        ),
      )
      .limit(1);
    return !!row;
  }
  async prepared(
    appId: string,
    conversationJid: string,
  ): Promise<PreparedSourceAnswer | undefined> {
    const [session] = await this.db
      .select()
      .from(s.controlHttpSessionsPostgres)
      .where(
        and(
          eq(s.controlHttpSessionsPostgres.appId, appId),
          eq(
            sql<string>`${s.controlHttpSessionsPostgres.externalRefJson}->>'chatJid'`,
            conversationJid,
          ),
        ),
      );
    if (!session) return;
    const [answer] = await this.db
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(
        and(
          eq(s.pendingInteractionsPostgres.appId, appId),
          eq(s.pendingInteractionsPostgres.status, 'pending'),
          sql`${s.pendingInteractionsPostgres.payloadJson}->>'interactionType' = 'source_answer'`,
          eq(
            sql<string>`${s.pendingInteractionsPostgres.payloadJson}#>>'{request,binding,discussionId}'`,
            session.externalConversationId,
          ),
          sql`${s.pendingInteractionsPostgres.payloadJson}->>'state' = 'queued'`,
        ),
      )
      .orderBy(
        sql`(${s.pendingInteractionsPostgres.payloadJson}#>>'{request,sourceCutoff}')::bigint`,
      )
      .limit(1);
    if (!answer) return;
    const payload = answer.payloadJson as AnswerPayload;
    const request = payload.request;
    if (Date.parse(request.deadlineAt) <= Date.now()) {
      await this.db.transaction((tx) =>
        this.finish(tx, appId, answer.id, 'failed', 'Answer deadline expired'),
      );
      return;
    }
    const [authority] = await this.db
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(eq(s.pendingInteractionsPostgres.id, `authority:${answer.id}`));
    const decision = (
      authority?.resolutionJson as { result?: SettleExecutionAuthority } | null
    )?.result;
    if (!decision?.allowed || Date.parse(decision.expiresAt) <= Date.now()) {
      await this.db.transaction((tx) =>
        this.finish(
          tx,
          appId,
          answer.id,
          'canceled',
          'Current execution authority expired',
        ),
      );
      return;
    }
    const load = async (sourceId: string) => {
      const [row] = await this.db
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
            eq(s.messagesPostgres.conversationId, session.conversationId),
            eq(s.messagesPostgres.sourceGeneration, request.binding.generation),
            eq(s.messagesPostgres.sourceMessageId, sourceId),
          ),
        );
      if (!row) {
        await this.db.transaction(async (tx) => {
          await lockSourceEventApp(tx, appId);
          const bound = await this.session(
            tx,
            appId,
            session.sessionId,
            request.binding,
          );
          await this.interaction(
            tx,
            bound,
            answer.id,
            request,
            `history:${answer.id}:id:${hash(sourceId).slice(0, 24)}`,
            'source_history',
            {
              sourceCutoff: request.sourceCutoff,
              afterPosition: '0',
              missingSourceIds: [sourceId],
              pageLimit: 50,
              byteLimit: 262144,
              sourceVersion: request.revisionId,
            },
          );
          await tx
            .update(s.pendingInteractionsPostgres)
            .set({ payloadJson: { ...payload, state: 'preparing' } })
            .where(eq(s.pendingInteractionsPostgres.id, answer.id));
        });
        return undefined;
      }
      if (
        BigInt(String(row.message.sourcePosition)) >
        BigInt(request.sourceCutoff)
      ) {
        await this.db.transaction((tx) =>
          this.finish(
            tx,
            appId,
            answer.id,
            'failed',
            'Reply ancestor exceeds frozen source cutoff',
          ),
        );
        return undefined;
      }
      return row;
    };
    const question = await load(request.questionSourceId);
    if (!question) return;
    const ancestry =
      (question.message.externalRefJson as { source: SourceMessage }).source
        .replyToSourceId !== null;
    let rows: NonNullable<Awaited<ReturnType<typeof load>>>[] = [];
    if (ancestry) {
      let current = question;
      const seen = new Set<string>();
      for (;;) {
        const source = (
          current.message.externalRefJson as { source: SourceMessage }
        ).source;
        if (seen.has(source.sourceMessageId) || seen.size >= 100) {
          await this.db.transaction((tx) =>
            this.finish(
              tx,
              appId,
              answer.id,
              'failed',
              'Source reply ancestry cyclic or exceeds bounded context',
            ),
          );
          return;
        }
        seen.add(source.sourceMessageId);
        rows.unshift(current);
        if (!source.replyToSourceId) break;
        const parent = await load(source.replyToSourceId);
        if (!parent) return;
        current = parent;
      }
    } else
      rows = await this.db
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
            eq(s.messagesPostgres.conversationId, session.conversationId),
            eq(s.messagesPostgres.sourceGeneration, request.binding.generation),
            sql`${s.messagesPostgres.sourcePosition} <= ${request.sourceCutoff}::bigint`,
          ),
        )
        .orderBy(desc(s.messagesPostgres.sourcePosition))
        .limit(80)
        .then((rows) => rows.reverse());
    const messages = rows.map(({ message, text }) => {
      const source = (message.externalRefJson as { source: SourceMessage })
        .source;
      return {
        id: source.sourceMessageId,
        chat_jid: conversationJid,
        provider: 'app',
        providerAccountId: `control:${appId}`,
        sender: source.authorId,
        sender_name: source.authorDisplayName,
        content: (text as { text: string }).text,
        timestamp: source.createdAt,
        is_from_me: source.authorKind === 'assistant',
        is_bot_message: source.authorKind === 'assistant',
        reply_to_message_id: source.replyToSourceId ?? undefined,
      } satisfies NewMessage;
    });
    if (Buffer.byteLength(JSON.stringify(messages)) > 262144) {
      await this.db.transaction((tx) =>
        this.finish(
          tx,
          appId,
          answer.id,
          'failed',
          'Required source context exceeds pinned byte budget',
        ),
      );
      return;
    }
    const selectedSourceIds = messages.map((row) => row.id);
    await this.db
      .update(s.pendingInteractionsPostgres)
      .set({
        payloadJson: {
          ...payload,
          contextSnapshot: {
            selectedSourceIds,
            selectionMode: ancestry ? 'ancestry' : 'recent',
            sourceVersion: request.revisionId,
            generation: request.binding.generation,
          },
        },
      })
      .where(eq(s.pendingInteractionsPostgres.id, answer.id));
    const [agent] = await this.db
      .select()
      .from(s.agentsPostgres)
      .where(eq(s.agentsPostgres.id, session.agentId));
    const [config] = await this.db
      .select()
      .from(s.agentConfigVersionsPostgres)
      .where(
        eq(s.agentConfigVersionsPostgres.id, agent!.currentConfigVersionId!),
      );
    const limits = JSON.parse(config!.runtimeLimitsJson) as {
      metadata?: { sourceChannelConcurrency?: number };
    };
    const capacity = limits.metadata?.sourceChannelConcurrency ?? 4;
    const slots = new PostgresWorkerCoordinationRepository(this.db);
    const claimToken = randomUUID();
    const poolKey = `source-answer-pool:${appId}:${session.agentId}`;
    const discussionKey = `source-answer-discussion:${appId}:${session.externalConversationId}`;
    if (
      !(await slots.acquireRunSlot({
        slotKey: poolKey,
        holderId: claimToken,
        capacity,
        ttlMs: 60000,
      }))
    )
      return;
    if (
      !(await slots.acquireRunSlot({
        slotKey: discussionKey,
        holderId: claimToken,
        capacity: 1,
        ttlMs: 60000,
      }))
    ) {
      await slots.releaseRunSlot({ slotKey: poolKey, holderId: claimToken });
      return;
    }
    await this.db
      .update(s.pendingInteractionsPostgres)
      .set({
        runLeaseToken: claimToken,
        payloadJson: {
          ...payload,
          sourceSlotKeys: [poolKey, discussionKey],
          contextSnapshot: {
            selectedSourceIds,
            selectionMode: ancestry ? 'ancestry' : 'recent',
            sourceVersion: request.revisionId,
            generation: request.binding.generation,
          },
        },
      })
      .where(eq(s.pendingInteractionsPostgres.id, answer.id));
    await this.db
      .insert(s.controlHttpResponseRoutesPostgres)
      .values({
        sessionId: session.sessionId,
        threadId: '',
        responseMode: 'sse',
        correlationId: request.answerGoalId,
      })
      .onConflictDoUpdate({
        target: [
          s.controlHttpResponseRoutesPostgres.sessionId,
          s.controlHttpResponseRoutesPostgres.threadId,
        ],
        set: { correlationId: request.answerGoalId, responseMode: 'sse' },
      });
    return { id: answer.id, request, messages, selectedSourceIds, claimToken };
  }
  async memoryContext(input: {
    answerId: string;
    appId: string;
    agentId: string;
    workspaceId: string;
    personId?: string;
  }) {
    const group = sourceChannelMemorySubject({ ...input, scope: 'group' });
    const personal = input.personId
      ? sourceChannelMemorySubject({ ...input, scope: 'user' })
      : undefined;
    const rows = await this.db
      .select()
      .from(s.memoryItemsPostgres)
      .where(
        and(
          eq(s.memoryItemsPostgres.appId, input.appId),
          eq(s.memoryItemsPostgres.agentId, input.agentId),
          eq(s.memoryItemsPostgres.status, 'active'),
          inArray(s.memoryItemsPostgres.kind, [
            'preference',
            'correction',
            'constraint',
          ]),
          sql`((${s.memoryItemsPostgres.subjectType} = 'group' AND ${s.memoryItemsPostgres.subjectId} = ${group.subjectId}) OR (${s.memoryItemsPostgres.subjectType} = 'user' AND ${s.memoryItemsPostgres.subjectId} = ${personal?.subjectId ?? ''}))`,
        ),
      )
      .orderBy(desc(s.memoryItemsPostgres.updatedAt))
      .limit(24);
    const [answer] = await this.db
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(eq(s.pendingInteractionsPostgres.id, input.answerId));
    if (answer)
      await this.db
        .update(s.pendingInteractionsPostgres)
        .set({
          payloadJson: {
            ...(answer.payloadJson as Record<string, unknown>),
            memoryVersions: rows.map((row) => ({
              id: row.id,
              updatedAt: row.updatedAt,
            })),
          },
        })
        .where(eq(s.pendingInteractionsPostgres.id, input.answerId));
    return rows.length
      ? 'Scoped workspace instructions and requester style. Apply only compatible general instructions. Never disclose preference records or treat these notes as tender evidence.\n' +
          rows
            .map((row) =>
              JSON.stringify({
                id: row.id,
                scope: row.subjectType,
                key: row.key,
                value: (row.valueJson as { value?: string }).value ?? '',
                version: row.updatedAt,
              }),
            )
            .join('\n')
      : '';
  }
}
