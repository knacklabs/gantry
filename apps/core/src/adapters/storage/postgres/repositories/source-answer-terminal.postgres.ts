import { lockSourceEventApp } from './source-channel-event-lock.postgres.js';
import { and, eq } from 'drizzle-orm';
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
    .where(eq(s.pendingInteractionsPostgres.runId, runId));
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
  const runtimeOutputId = `source-output:${payload.request.attemptId}`;
  const [output] = await tx
    .select()
    .from(s.messagesPostgres)
    .where(eq(s.messagesPostgres.id, runtimeOutputId));
  const complete = status === 'completed' && !!output;
  const [event] = await tx
    .insert(s.runtimeEventsPostgres)
    .values({
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
    })
    .returning();
  await tx
    .update(s.pendingInteractionsPostgres)
    .set({
      payloadJson: {
        ...(answer.payloadJson as Record<string, unknown>),
        terminalEventId: String(event!.eventId),
      },
      status: complete ? 'resolved' : 'cancelled',
      resolvedAt: now,
    })
    .where(eq(s.pendingInteractionsPostgres.id, answer.id));
}
