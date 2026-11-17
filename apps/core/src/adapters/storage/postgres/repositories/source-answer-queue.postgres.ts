import { and, asc, eq, sql } from 'drizzle-orm';
import { SourceAnswerMemoryRepository } from './source-answer-memory.postgres.js';
import { makeAgentThreadQueueKey } from '../../../../shared/thread-queue-key.js';
import type { AnswerPayload } from './source-answer-base.postgres.js';
import * as s from '../schema/schema.js';
export class SourceAnswerQueueRepository extends SourceAnswerMemoryRepository {
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
}
