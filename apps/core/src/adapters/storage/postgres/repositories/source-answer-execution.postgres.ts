import { lockSourceEventApp } from './source-channel-event-lock.postgres.js';
import { PostgresWorkerCoordinationRepository } from './worker-coordination-repository.postgres.js';
import { and, eq, sql } from 'drizzle-orm';
import * as s from '../schema/schema.js';
import { SourceAnswerContextRepository } from './source-answer-context.postgres.js';
import { type AnswerPayload, fail } from './source-answer-base.postgres.js';
export class SourceAnswerExecutionRepository extends SourceAnswerContextRepository {
  async markRun(id: string, runId: string) {
    const [answer] = await this.db
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(eq(s.pendingInteractionsPostgres.id, id));
    if (!answer || answer.status !== 'pending')
      fail('Source answer no longer active');
    if (answer!.runId && answer!.runId !== runId)
      fail('Source answer already associated with another native run');
    await this.db
      .update(s.pendingInteractionsPostgres)
      .set({
        runId,
        payloadJson: {
          ...(answer!.payloadJson as Record<string, unknown>),
          state: 'running',
        },
      })
      .where(eq(s.pendingInteractionsPostgres.id, id));
  }
  async output(id: string, runId: string, text: string) {
    if (!text.trim() || Buffer.byteLength(text) > 262144)
      fail('Complete source answer output is missing or exceeds byte limit');
    const [owned] = await this.db
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(eq(s.pendingInteractionsPostgres.id, id));
    if (!owned) fail('Source answer not found');
    await this.db.transaction(async (tx) => {
      await lockSourceEventApp(tx, owned!.appId);
      const [answer] = await tx
        .select()
        .from(s.pendingInteractionsPostgres)
        .where(eq(s.pendingInteractionsPostgres.id, id))
        .for('update');
      if (!answer || answer.status !== 'pending' || answer.runId !== runId)
        fail('Source answer output is fenced');
      const held = await tx
        .select()
        .from(s.runSlotsPostgres)
        .where(
          and(
            eq(s.runSlotsPostgres.holderId, answer!.runLeaseToken!),
            sql`${s.runSlotsPostgres.expiresAt} > now()`,
          ),
        );
      if (held.length !== 2) fail('Source answer slot lease expired');
      const payload = answer!.payloadJson as AnswerPayload;
      const [session] = await tx
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
        );
      if (!session) fail('Source answer session absent');
      const outputId = `source-output:${payload.request.attemptId}`;
      const inserted = await tx
        .insert(s.messagesPostgres)
        .values({
          id: outputId,
          appId: session!.appId,
          providerId: 'app',
          providerAccountId: `control:${session!.appId}`,
          conversationId: session!.conversationId,
          direction: 'outbound',
          senderDisplayName: 'Agent',
          trust: 'system',
          createdAt: new Date().toISOString(),
          deliveryStatus: 'pending',
          externalRefJson: {
            sourceAnswerGoalId: payload.request.answerGoalId,
            sourceAnswerAttemptId: payload.request.attemptId,
            sourceRunId: runId,
          },
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) return;
      await tx.insert(s.messagePartsPostgres).values({
        messageId: outputId,
        ordinal: 0,
        kind: 'text',
        payloadJson: { text },
      });
      await tx.insert(s.runtimeEventsPostgres).values({
        appId: session!.appId,
        agentId: session!.agentId,
        sessionId: session!.sessionId,
        runId,
        conversationId: session!.conversationId,
        eventType: 'session.message.outbound',
        actor: 'agent',
        correlationId: payload.request.answerGoalId,
        payloadJson: JSON.stringify({
          text,
          runtimeOutputId: outputId,
          answerGoalId: payload.request.answerGoalId,
          attemptId: payload.request.attemptId,
        }),
      });
    });
  }
  async renewPrepared(id: string, claimToken: string) {
    const [answer] = await this.db
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(eq(s.pendingInteractionsPostgres.id, id));
    if (
      !answer ||
      answer.runLeaseToken !== claimToken ||
      answer.status !== 'pending'
    )
      return false;
    const slots = new PostgresWorkerCoordinationRepository(this.db);
    const keys = (answer.payloadJson as { sourceSlotKeys: string[] })
      .sourceSlotKeys;
    const renewals = await Promise.all(
      keys.map((slotKey) =>
        slots.renewRunSlot({ slotKey, holderId: claimToken, ttlMs: 60000 }),
      ),
    );
    return renewals.every(Boolean);
  }
  async finishPrepared(id: string, success: boolean, claimToken?: string) {
    const [answer] = await this.db
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(eq(s.pendingInteractionsPostgres.id, id));
    if (!answer || (claimToken && answer.runLeaseToken !== claimToken)) return;
    const slots = new PostgresWorkerCoordinationRepository(this.db);
    for (const slotKey of (answer.payloadJson as { sourceSlotKeys?: string[] })
      .sourceSlotKeys ?? [])
      await slots.releaseRunSlot({ slotKey, holderId: answer.runLeaseToken! });
    await this.db
      .update(s.pendingInteractionsPostgres)
      .set({
        status: success ? 'resolved' : 'cancelled',
        payloadJson: {
          ...(answer.payloadJson as Record<string, unknown>),
          state: success ? 'completed' : 'failed',
        },
        resolvedAt: new Date().toISOString(),
      })
      .where(eq(s.pendingInteractionsPostgres.id, id));
  }
}
