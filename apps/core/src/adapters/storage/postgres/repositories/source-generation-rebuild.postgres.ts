import type {
  RebuildSourceGeneration,
  RebuildSourceGenerationResponse,
  SourceBinding,
} from '@gantry/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { ApplicationError } from '../../../../application/common/application-error.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { hash } from './source-answer-base.postgres.js';
import {
  appendSourceRuntimeEvent,
  lockSourceEventApp,
} from './source-channel-event-lock.postgres.js';
import * as schema from '../schema/schema.js';
const conflict = (message: string): never => {
  throw new ApplicationError('CONFLICT', message);
};
export async function rebuildSourceGeneration(
  db: CanonicalDb,
  appId: string,
  sessionId: string,
  input: RebuildSourceGeneration,
): Promise<RebuildSourceGenerationResponse> {
  return db.transaction(async (tx) => {
    await lockSourceEventApp(tx, appId);
    const [session] = await tx
      .select()
      .from(schema.controlHttpSessionsPostgres)
      .where(
        and(
          eq(schema.controlHttpSessionsPostgres.appId, appId),
          eq(schema.controlHttpSessionsPostgres.sessionId, sessionId),
        ),
      )
      .for('update');
    if (!session) conflict('Source session absent');
    const ref = session!.externalRefJson as Record<string, unknown>;
    const [existing] = await tx
      .select()
      .from(schema.runtimeEventsPostgres)
      .where(
        and(
          eq(schema.runtimeEventsPostgres.appId, appId),
          eq(schema.runtimeEventsPostgres.sessionId, sessionId),
          eq(
            schema.runtimeEventsPostgres.eventType,
            'source.generation.rebuilt',
          ),
          sql`${schema.runtimeEventsPostgres.payloadJson}::jsonb->>'idempotencyKey'=${input.idempotencyKey}`,
        ),
      )
      .limit(1);
    if (existing) {
      const saved = JSON.parse(existing.payloadJson) as {
        binding: SourceBinding;
        requestHash: string;
      };
      if (saved.requestHash !== hash(input))
        conflict('Generation rebuild idempotency conflict');
      return {
        binding: saved.binding,
        contiguousPosition: '0',
        persistedEventId: String(existing.eventId),
        replayed: true,
      };
    }
    const prior = ref.sourceGenerationRebuild as
      | {
          input: RebuildSourceGeneration;
          receipt: RebuildSourceGenerationResponse;
        }
      | undefined;
    if (prior && prior.input.idempotencyKey === input.idempotencyKey) {
      if (hash(prior.input) !== hash(input))
        conflict('Generation rebuild idempotency conflict');
      return { ...prior.receipt, replayed: true };
    }
    const binding = ref.sourceBinding as SourceBinding | undefined;
    if (
      !binding ||
      binding.discussionId !== input.binding.discussionId ||
      binding.generation !== input.binding.generation ||
      binding.workspaceId !== input.binding.workspaceId ||
      binding.tenderId !== input.binding.tenderId ||
      input.nextGeneration !== binding.generation + 1
    )
      conflict(
        'Generation rebuild requires exact current binding and next generation',
      );
    if (!binding) conflict('Source binding absent');
    const current = binding!;
    const pending = await tx
      .select()
      .from(schema.pendingInteractionsPostgres)
      .where(
        and(
          eq(schema.pendingInteractionsPostgres.appId, appId),
          eq(schema.pendingInteractionsPostgres.status, 'pending'),
          sql`${schema.pendingInteractionsPostgres.payloadJson}#>>'{request,binding,discussionId}' = ${current.discussionId}`,
        ),
      );
    for (const row of pending) {
      const payload = row.payloadJson as Record<string, unknown>;
      await tx
        .update(schema.pendingInteractionsPostgres)
        .set({
          status: 'cancelled',
          runLeaseToken: null,
          resolvedAt: new Date().toISOString(),
          payloadJson: {
            ...payload,
            state: 'canceled',
            generationInvalidated: true,
          },
        })
        .where(eq(schema.pendingInteractionsPostgres.id, row.id));
      if (row.runLeaseToken)
        await tx
          .delete(schema.runSlotsPostgres)
          .where(eq(schema.runSlotsPostgres.holderId, row.runLeaseToken));
      if (payload.interactionType === 'source_answer') {
        const request = payload.request as {
          answerGoalId: string;
          attemptId: string;
        };
        await appendSourceRuntimeEvent(tx, {
          appId,
          agentId: session!.agentId,
          sessionId,
          runId: row.runId,
          conversationId: session!.conversationId,
          eventType: 'source.answer.canceled',
          actor: 'sdk',
          correlationId: request.answerGoalId,
          payloadJson: JSON.stringify({
            answerGoalId: request.answerGoalId,
            attemptId: request.attemptId,
            errorSummary: 'Source generation rebuilt',
          }),
        });
      }
    }
    const next = { ...current, generation: input.nextGeneration };
    const [event] = await appendSourceRuntimeEvent(tx, {
      appId,
      agentId: session!.agentId,
      sessionId,
      conversationId: session!.conversationId,
      eventType: 'source.generation.rebuilt',
      actor: 'sdk',
      payloadJson: JSON.stringify({
        binding: next,
        priorGeneration: current.generation,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash(input),
      }),
    });
    const receipt = {
      binding: next,
      contiguousPosition: '0',
      persistedEventId: String(event!.eventId),
      replayed: false,
    };
    await tx
      .update(schema.controlHttpSessionsPostgres)
      .set({
        externalRefJson: {
          ...ref,
          sourceBinding: next,
          sourceContiguousPosition: '0',
          sourceGenerationRebuild: { input, receipt },
        },
      })
      .where(eq(schema.controlHttpSessionsPostgres.sessionId, sessionId));
    return receipt;
  });
}
