import { requireSourceModelSnapshot } from '../../../../shared/source-model-snapshot.js';
import type { ConversationRoute } from '../../../../domain/types.js';
import { folderForAgentId } from '../../../../domain/agent/agent-folder-id.js';
import { hash, type AnswerPayload } from './source-answer-base.postgres.js';
import { and, asc, eq, sql } from 'drizzle-orm';
import { SourceAnswerMemoryRepository } from './source-answer-memory.postgres.js';
import { makeAgentThreadQueueKey } from '../../../../shared/thread-queue-key.js';
import * as s from '../schema/schema.js';
export class SourceAnswerQueueRepository extends SourceAnswerMemoryRepository {
  async dispatchRoute(
    appId: string,
    conversationJid: string,
    failureReason?: string,
  ): Promise<{ source: true; route?: ConversationRoute } | undefined> {
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
          sql`${s.pendingInteractionsPostgres.payloadJson}->>'interactionType'='source_answer'`,
          eq(
            sql<string>`${s.pendingInteractionsPostgres.payloadJson}#>>'{request,binding,discussionId}'`,
            session.externalConversationId,
          ),
          sql`${s.pendingInteractionsPostgres.payloadJson}->>'state'='queued'`,
        ),
      )
      .orderBy(asc(s.pendingInteractionsPostgres.createdAt))
      .limit(1);
    if (!answer) return;
    const payload = answer.payloadJson as AnswerPayload;
    const request = payload.request;
    try {
      requireSourceModelSnapshot(payload.modelSnapshot);
    } catch {
      await this.db.transaction((tx) =>
        this.finish(
          tx,
          appId,
          answer.id,
          'failed',
          'Source answer model snapshot unavailable; start a new attempt',
        ),
      );
      return { source: true };
    }
    const [agent] = await this.db
      .select()
      .from(s.agentsPostgres)
      .where(
        and(
          eq(s.agentsPostgres.id, session.agentId),
          eq(s.agentsPostgres.appId, appId),
        ),
      );
    const folder = folderForAgentId(session.agentId as never);
    const failure =
      failureReason ??
      (Date.parse(request.deadlineAt) <= Date.now()
        ? 'Answer deadline expired'
        : !agent ||
            agent.status !== 'active' ||
            !agent.currentConfigVersionId ||
            !folder ||
            answer.sourceAgentFolder !== session.agentId ||
            hash(
              (session.externalRefJson as Record<string, unknown>)
                .sourceBinding,
            ) !== hash(request.binding)
          ? 'Source answer routing prerequisite unavailable'
          : undefined);
    if (failure) {
      await this.db.transaction((tx) =>
        this.finish(tx, appId, answer.id, 'failed', failure),
      );
      return { source: true };
    }
    return {
      source: true,
      route: {
        name: agent!.name,
        folder: folder!,
        trigger: '',
        requiresTrigger: false,
        added_at: session.createdAt,
        providerAccountId: `control:${appId}`,
        conversationId: session.conversationId,
        conversationKind: 'channel',
        senderIdentityEvidenceType: 'web_user',
        systemSenderIds: ['sdk'],
        agentConfig: { model: request.model },
      },
    };
  }
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
