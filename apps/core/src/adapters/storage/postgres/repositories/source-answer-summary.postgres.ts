import { and, desc, eq, sql } from 'drizzle-orm';
import type { SourceSummaryWork } from '../../../../domain/ports/source-discussion.js';
import {
  SourceAnswerRepositoryBase,
  type AnswerPayload,
  fail,
} from './source-answer-base.postgres.js';
import { lockSourceEventApp } from './source-channel-event-lock.postgres.js';
import * as s from '../schema/schema.js';

export class SourceAnswerSummaryRepository extends SourceAnswerRepositoryBase {
  async priorDigest(
    sessionId: string,
    generation: number,
    workspaceId: string,
    profileVersion: string,
    cutoff: string,
  ) {
    const [row] = await this.db
      .select()
      .from(s.agentSessionDigestsPostgres)
      .where(
        and(
          eq(s.agentSessionDigestsPostgres.agentSessionId, sessionId),
          eq(s.agentSessionDigestsPostgres.trigger, 'source-context'),
          eq(
            sql<string>`${s.agentSessionDigestsPostgres.metadataJson}->>'selectionMode'`,
            'recent',
          ),
          eq(
            sql<string>`${s.agentSessionDigestsPostgres.metadataJson}->>'generation'`,
            String(generation),
          ),
          eq(
            sql<string>`${s.agentSessionDigestsPostgres.metadataJson}->>'workspaceId'`,
            workspaceId,
          ),
          eq(
            sql<string>`${s.agentSessionDigestsPostgres.metadataJson}->>'profileVersion'`,
            profileVersion,
          ),
          sql`(${s.agentSessionDigestsPostgres.metadataJson}->>'throughPosition')::bigint < ${cutoff}::bigint`,
        ),
      )
      .orderBy(desc(s.agentSessionDigestsPostgres.createdAt))
      .limit(1);
    return row;
  }
  async readSummary(id: string) {
    const [row] = await this.db
      .select()
      .from(s.agentSessionDigestsPostgres)
      .where(eq(s.agentSessionDigestsPostgres.id, id));
    return row?.digest;
  }
  async saveSummary(input: {
    answerId: string;
    claimToken: string;
    work: SourceSummaryWork;
    text: string;
    usage: Record<string, unknown>[];
  }): Promise<string> {
    const [owner] = await this.db
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(eq(s.pendingInteractionsPostgres.id, input.answerId));
    if (!owner) fail('Source summary owner absent');
    return this.db.transaction(async (tx) => {
      await lockSourceEventApp(tx, owner!.appId);
      const [answer] = await tx
        .select()
        .from(s.pendingInteractionsPostgres)
        .where(eq(s.pendingInteractionsPostgres.id, input.answerId))
        .for('update');
      if (
        !answer ||
        answer.status !== 'pending' ||
        answer.runLeaseToken !== input.claimToken
      )
        fail('Source summary ownership is fenced');
      const payload = answer!.payloadJson as AnswerPayload;
      const session = await this.session(
        tx,
        answer!.appId,
        (
          await tx
            .select()
            .from(s.controlHttpSessionsPostgres)
            .where(
              and(
                eq(s.controlHttpSessionsPostgres.appId, answer!.appId),
                eq(
                  s.controlHttpSessionsPostgres.externalConversationId,
                  payload.request.binding.discussionId,
                ),
              ),
            )
        )[0]!.sessionId,
        payload.request.binding,
      );
      const held = await tx
        .select()
        .from(s.runSlotsPostgres)
        .where(
          and(
            eq(s.runSlotsPostgres.holderId, input.claimToken),
            sql`${s.runSlotsPostgres.expiresAt}>now()`,
          ),
        );
      if (held.length !== 2) fail('Source summary lease expired');
      const metadata = {
        selectionMode: input.work.mode,
        generation: input.work.generation,
        workspaceId: input.work.workspaceId,
        sourceVersion: input.work.sourceVersion,
        profileVersion: input.work.profileVersion,
        throughPosition: input.work.throughPosition,
        coveredSourceIds:
          input.work.mode === 'ancestry' ? input.work.sourceIds : undefined,
        coveredRange:
          input.work.mode === 'recent'
            ? { after: '0', through: input.work.throughPosition }
            : undefined,
        previousDigestId: input.work.previousDigestId,
        usage: input.usage,
        successfulAnswer: false,
        selectedInputTokens: input.work.inputTokens,
      };
      await tx
        .insert(s.agentSessionDigestsPostgres)
        .values({
          id: input.work.id,
          appId: session.appId,
          agentSessionId: session.sessionId,
          trigger: 'source-context',
          digest: input.text,
          messageCount: input.work.sourceIds.length,
          metadataJson: metadata,
          scopeAppId: session.appId,
          scopeAgentId: session.agentId,
          scopeConversationId: session.conversationId,
        })
        .onConflictDoNothing();
      await tx
        .update(s.pendingInteractionsPostgres)
        .set({
          payloadJson: {
            ...(answer!.payloadJson as Record<string, unknown>),
            contextSummaryId: input.work.id,
            contextSummaryCoverage: metadata,
          },
        })
        .where(eq(s.pendingInteractionsPostgres.id, input.answerId));
      return input.text;
    });
  }
}
