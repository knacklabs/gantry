import { sourceAnswerOutputId } from './source-answer-output-id.js';
import {
  appendSourceRuntimeEvent,
  lockSourceEventApp,
} from './source-channel-event-lock.postgres.js';
import { and, eq, sql } from 'drizzle-orm';
import type { RequestSourceAnswer } from '@gantry/contracts';
import * as s from '../schema/schema.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';

/** Called only inside the native run lease's fenced terminal transaction. */
export async function appendSourceAnswerTerminal(
  tx: CanonicalExecutor,
  runId: string,
  status: 'completed' | 'failed' | 'canceled',
  now: string,
) {
  const [answer] = await tx
    .select()
    .from(s.pendingInteractionsPostgres)
    .where(
      and(
        eq(s.pendingInteractionsPostgres.runId, runId),
        sql`${s.pendingInteractionsPostgres.payloadJson}->>'interactionType' = 'source_answer'`,
      ),
    );
  if (
    !answer ||
    (answer.payloadJson as { interactionType?: string }).interactionType !==
      'source_answer'
  )
    return;
  const payload = answer.payloadJson as {
    request: RequestSourceAnswer;
    terminalEventId?: string;
  };
  if (payload.terminalEventId) return;
  const [session] = await tx
    .select()
    .from(s.controlHttpSessionsPostgres)
    .where(
      and(
        eq(s.controlHttpSessionsPostgres.appId, answer.appId),
        eq(
          s.controlHttpSessionsPostgres.externalConversationId,
          payload.request.binding.discussionId,
        ),
      ),
    );
  if (!session) return;
  await lockSourceEventApp(tx, answer.appId);
  const runtimeOutputId = sourceAnswerOutputId(
    answer!.appId,
    payload.request.answerGoalId,
    payload.request.attemptId,
  );
  const [output] = await tx
    .select()
    .from(s.messagesPostgres)
    .where(
      and(
        eq(s.messagesPostgres.id, runtimeOutputId),
        eq(s.messagesPostgres.appId, answer.appId),
        eq(s.messagesPostgres.conversationId, session.conversationId),
      ),
    );
  const outputRef = output?.externalRefJson as
    | {
        sourceRunId?: string;
        sourceAnswerGoalId?: string;
        sourceAnswerAttemptId?: string;
      }
    | undefined;
  const complete =
    status === 'completed' &&
    !(answer.payloadJson as { generationInvalidated?: boolean })
      .generationInvalidated &&
    !!output &&
    outputRef?.sourceRunId === runId &&
    outputRef.sourceAnswerGoalId === payload.request.answerGoalId &&
    outputRef.sourceAnswerAttemptId === payload.request.attemptId;
  const [event] = await appendSourceRuntimeEvent(tx, {
    appId: answer.appId,
    agentId: session.agentId,
    sessionId: session.sessionId,
    runId,
    conversationId: session.conversationId,
    eventType: complete
      ? 'run.completed'
      : status === 'canceled'
        ? 'run.canceled'
        : 'run.failed',
    actor: 'agent',
    correlationId: payload.request.answerGoalId,
    createdAt: now,
    payloadJson: JSON.stringify({
      answerGoalId: payload.request.answerGoalId,
      attemptId: payload.request.attemptId,
      ...(complete
        ? { runtimeOutputId }
        : {
            errorSummary:
              'Native source answer failed before complete fenced output',
          }),
    }),
  });
  if (answer.runLeaseToken)
    await tx
      .delete(s.runSlotsPostgres)
      .where(eq(s.runSlotsPostgres.holderId, answer.runLeaseToken));
  await tx
    .update(s.pendingInteractionsPostgres)
    .set({
      payloadJson: {
        ...(answer.payloadJson as Record<string, unknown>),
        terminalEventId: String(event!.eventId),
        state: complete
          ? 'completed'
          : status === 'canceled'
            ? 'canceled'
            : 'failed',
      },
      status: complete ? 'resolved' : 'cancelled',
      resolvedAt: now,
    })
    .where(eq(s.pendingInteractionsPostgres.id, answer.id));
}
