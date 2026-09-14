import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { onboardingVerificationsPostgres } from '../schema/schema.js';
import type { Message } from '../../../../domain/messages/messages.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';

export async function correlateOnboardingVerification(
  tx: CanonicalExecutor,
  input: {
    appId: string;
    agentRunId?: string;
    canonicalMessageId: string;
    conversationId: string;
    direction: 'inbound' | 'outbound';
    eventAt: string;
    providerAccountId: string;
    replyToMessageId?: string;
    text?: string;
    threadId?: string | null;
    deliveryStatus?: string;
  },
): Promise<void> {
  const scope = and(
    eq(onboardingVerificationsPostgres.appId, input.appId),
    eq(
      onboardingVerificationsPostgres.providerAccountId,
      input.providerAccountId,
    ),
    eq(onboardingVerificationsPostgres.conversationId, input.conversationId),
    input.threadId
      ? eq(onboardingVerificationsPostgres.threadId, input.threadId)
      : isNull(onboardingVerificationsPostgres.threadId),
  );
  if (input.direction === 'inbound' && input.text?.trim()) {
    await tx
      .update(onboardingVerificationsPostgres)
      .set({
        status: 'inbound_received',
        inboundMessageId: input.canonicalMessageId,
        updatedAt: input.eventAt,
        updatedBy: 'runtime:inbound-message',
      })
      .where(
        and(
          scope,
          eq(onboardingVerificationsPostgres.status, 'pending'),
          gt(onboardingVerificationsPostgres.expiresAt, input.eventAt),
          sql`${input.text} ~ ('(^|[^A-Z0-9-])' || ${onboardingVerificationsPostgres.challenge} || '([^A-Z0-9-]|$)')`,
        ),
      );
    return;
  }
  if (
    input.direction !== 'outbound' ||
    input.deliveryStatus !== 'sent' ||
    !input.agentRunId ||
    !input.replyToMessageId
  ) {
    return;
  }
  await tx
    .update(onboardingVerificationsPostgres)
    .set({
      status: 'satisfied',
      outboundMessageId: input.canonicalMessageId,
      onboardingRunId: input.agentRunId,
      satisfiedAt: input.eventAt,
      updatedAt: input.eventAt,
      updatedBy: 'runtime:outbound-message',
    })
    .where(
      and(
        scope,
        eq(onboardingVerificationsPostgres.status, 'inbound_received'),
        gt(onboardingVerificationsPostgres.expiresAt, input.eventAt),
        sql`${input.replyToMessageId} = (SELECT COALESCE("onboarding_inbound"."external_message_id", "onboarding_inbound"."id") FROM "messages" AS "onboarding_inbound" WHERE "onboarding_inbound"."id" = ${onboardingVerificationsPostgres.inboundMessageId} AND "onboarding_inbound"."created_at" <= ${input.eventAt})`,
        sql`EXISTS (SELECT 1 FROM "agent_runs" AS "onboarding_run" WHERE "onboarding_run"."id" = ${input.agentRunId} AND "onboarding_run"."agent_id" = ${onboardingVerificationsPostgres.agentId} AND "onboarding_run"."conversation_id" = ${input.conversationId} AND "onboarding_run"."thread_id" IS NOT DISTINCT FROM ${input.threadId ?? null})`,
      ),
    );
}

export async function correlateDomainOnboardingMessage(
  tx: CanonicalExecutor,
  input: {
    message: Message;
    canonicalMessageId: string;
    providerAccountId: string;
    eventAt: string;
  },
): Promise<void> {
  if (
    input.message.direction !== 'inbound' &&
    input.message.direction !== 'outbound'
  ) {
    return;
  }
  await correlateOnboardingVerification(tx, {
    appId: input.message.appId,
    agentRunId: input.message.runId,
    canonicalMessageId: input.canonicalMessageId,
    conversationId: input.message.conversationId,
    direction: input.message.direction,
    eventAt: input.eventAt,
    providerAccountId: input.providerAccountId,
    replyToMessageId: input.message.replyToMessageId,
    text: input.message.parts
      .flatMap((part) =>
        part.kind === 'text'
          ? [part.text]
          : part.kind === 'markdown'
            ? [part.markdown]
            : [],
      )
      .join('\n'),
    threadId: input.message.threadId,
    deliveryStatus: input.message.deliveryStatus,
  });
}
