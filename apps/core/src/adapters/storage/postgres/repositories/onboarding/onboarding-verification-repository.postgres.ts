import { randomUUID } from 'node:crypto';

import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';

import { stableSha256Json } from '../../../../../shared/stable-hash.js';
import {
  conversationIdForJid,
  type CanonicalDb,
} from '../canonical-graph-repository.postgres.js';
import { messageIdFor } from '../canonical-message-repository-identifiers.js';
import * as schema from '../../schema/schema.js';
import type { OnboardingDeploymentRepository } from './onboarding-deployment-repository.postgres.js';

export class OnboardingVerificationRepository {
  constructor(
    private readonly db: CanonicalDb,
    private readonly deployments: OnboardingDeploymentRepository,
  ) {}

  async createChallenge(input: {
    appId: string;
    userId: string;
    challengeText: string;
  }) {
    const deployment = await this.deployments.ensureDeployment(input);
    if (
      !deployment.agentId ||
      !deployment.providerAccountId ||
      !deployment.conversationId ||
      !deployment.approverPersonId ||
      !deployment.desiredStateRevision ||
      deployment.state !== 'verification_required'
    ) {
      throw new Error(
        'The current onboarding deployment is not ready for verification.',
      );
    }
    const [receipt] = await this.db
      .select()
      .from(schema.settingsRevisionReceiptsPostgres)
      .where(
        and(
          eq(schema.settingsRevisionReceiptsPostgres.appId, input.appId),
          eq(
            schema.settingsRevisionReceiptsPostgres.revision,
            deployment.desiredStateRevision,
          ),
          eq(schema.settingsRevisionReceiptsPostgres.status, 'applied'),
        ),
      )
      .limit(1);
    if (!receipt)
      throw new Error('Runtime projection has not been acknowledged.');
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.onboardingVerificationAttemptsPostgres)
        .set({ state: 'superseded', updatedAt: now.toISOString() })
        .where(
          and(
            eq(
              schema.onboardingVerificationAttemptsPostgres.deploymentId,
              deployment.id,
            ),
            sql`${schema.onboardingVerificationAttemptsPostgres.state} IN ('waiting_for_message', 'queued', 'running', 'awaiting_delivery')`,
          ),
        );
      await tx.insert(schema.onboardingVerificationAttemptsPostgres).values({
        id,
        deploymentId: deployment.id,
        appId: input.appId,
        deploymentVersion: deployment.version,
        challengeHash: stableSha256Json({ challenge: input.challengeText }),
        challengeText: input.challengeText,
        state: 'waiting_for_message',
        expiresAt,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    });
    return {
      id,
      state: 'waiting_for_message' as const,
      message: input.challengeText,
      expiresAt,
      deploymentVersion: deployment.version,
    };
  }

  async currentChallenge(input: { appId: string; userId: string }) {
    const deployment = await this.deployments.ensureDeployment(input);
    const [attempt] = await this.db
      .select()
      .from(schema.onboardingVerificationAttemptsPostgres)
      .where(
        and(
          eq(
            schema.onboardingVerificationAttemptsPostgres.deploymentId,
            deployment.id,
          ),
          eq(schema.onboardingVerificationAttemptsPostgres.appId, input.appId),
        ),
      )
      .orderBy(desc(schema.onboardingVerificationAttemptsPostgres.createdAt))
      .limit(1);
    if (!attempt) return null;
    if (
      Date.parse(attempt.expiresAt) <= Date.now() &&
      !['succeeded', 'failed', 'expired', 'superseded'].includes(attempt.state)
    ) {
      const [expired] = await this.db
        .update(schema.onboardingVerificationAttemptsPostgres)
        .set({ state: 'expired', updatedAt: new Date().toISOString() })
        .where(eq(schema.onboardingVerificationAttemptsPostgres.id, attempt.id))
        .returning();
      return expired!;
    }
    return this.refreshChallenge(attempt, deployment);
  }

  async matchInboundChallenge(input: {
    appId: string;
    agentId: string;
    providerAccountId: string;
    conversationId: string;
    senderExternalUserId: string;
    content: string;
  }): Promise<{ attemptId: string | null; blocked: boolean }> {
    const d = schema.onboardingDeploymentsPostgres;
    const a = schema.onboardingVerificationAttemptsPostgres;
    const aliases = schema.userAliasesPostgres;
    const [deployment] = await this.db
      .select({ id: d.id, state: d.state, conversationId: d.conversationId })
      .from(d)
      .where(
        and(
          eq(d.appId, input.appId),
          eq(d.agentId, input.agentId),
          eq(d.providerAccountId, input.providerAccountId),
        ),
      )
      .limit(1);
    if (!deployment || deployment.state === 'ready') {
      return { attemptId: null, blocked: false };
    }
    if (
      !deployment.conversationId ||
      !(await this.sameProviderConversation(
        deployment.conversationId,
        input.conversationId,
        input.providerAccountId,
      ))
    ) {
      return { attemptId: null, blocked: true };
    }
    const rows = await this.db
      .select({ id: a.id, challengeText: a.challengeText })
      .from(a)
      .innerJoin(d, eq(d.id, a.deploymentId))
      .innerJoin(
        aliases,
        and(
          eq(aliases.appId, d.appId),
          eq(aliases.provider, 'slack'),
          eq(aliases.providerAccountId, d.providerAccountId),
          eq(aliases.externalUserId, input.senderExternalUserId),
          eq(aliases.verificationStatus, 'verified'),
          sql`${aliases.retiredAt} IS NULL`,
          // The approver can always answer; anyone else needs to be in the
          // conversation's allowlist (agent_conversation_allowlist). A
          // deployment with no allowlist configured falls back to
          // approver-only, so this never loosens behaviour for a deployment
          // that never set one up.
          or(
            eq(aliases.userId, d.approverPersonId),
            sql`EXISTS (
              SELECT 1 FROM ${schema.agentConversationAllowlistPostgres} al
              WHERE al.app_id = ${d.appId}
                AND al.agent_id = ${d.agentId}
                AND al.conversation_id = ${d.conversationId}
                AND al.external_user_id = ${aliases.externalUserId}
            )`,
          ),
        ),
      )
      .where(
        and(
          eq(d.appId, input.appId),
          eq(d.agentId, input.agentId),
          eq(d.providerAccountId, input.providerAccountId),
          eq(d.id, deployment.id),
          eq(a.deploymentVersion, d.version),
          eq(a.state, 'waiting_for_message'),
          sql`${a.expiresAt} > now()`,
        ),
      );
    const match = rows.find((row) => {
      const nonce = row.challengeText.split('·').at(-1)?.trim();
      return Boolean(nonce && input.content.includes(nonce));
    });
    return { attemptId: match?.id ?? null, blocked: !match };
  }

  async consumeInboundChallenge(input: {
    attemptId: string;
    conversationJid: string;
    externalMessageId: string;
    providerAccountId: string;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.onboardingVerificationAttemptsPostgres)
        .set({
          state: 'queued',
          inboundMessageId: messageIdFor(
            input.conversationJid,
            input.externalMessageId,
            input.providerAccountId,
          ),
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(
              schema.onboardingVerificationAttemptsPostgres.id,
              input.attemptId,
            ),
            eq(
              schema.onboardingVerificationAttemptsPostgres.state,
              'waiting_for_message',
            ),
            sql`${schema.onboardingVerificationAttemptsPostgres.expiresAt} > now()`,
          ),
        )
        .returning({
          deploymentId:
            schema.onboardingVerificationAttemptsPostgres.deploymentId,
        });
      if (!row) return false;
      await tx
        .update(schema.onboardingDeploymentsPostgres)
        .set({
          conversationId: conversationIdForJid(
            input.conversationJid,
            input.providerAccountId,
          ),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.onboardingDeploymentsPostgres.id, row.deploymentId));
      return true;
    });
  }

  private async sameProviderConversation(
    configuredConversationId: string,
    inboundConversationId: string,
    providerAccountId: string,
  ): Promise<boolean> {
    if (configuredConversationId === inboundConversationId) return true;
    const c = schema.conversationsPostgres;
    const rows = await this.db
      .select({
        id: c.id,
        providerAccountId: c.providerAccountId,
        externalId: sql<string>`${c.externalRefJson}::jsonb ->> 'value'`,
      })
      .from(c)
      .where(inArray(c.id, [configuredConversationId, inboundConversationId]));
    if (rows.length !== 2) return false;
    const [first, second] = rows;
    return (
      Boolean(first?.externalId) &&
      first?.externalId === second?.externalId &&
      rows.every((row) => row.providerAccountId === providerAccountId)
    );
  }

  private async refreshChallenge(
    attempt: typeof schema.onboardingVerificationAttemptsPostgres.$inferSelect,
    deployment: typeof schema.onboardingDeploymentsPostgres.$inferSelect,
  ) {
    if (
      !attempt.inboundMessageId ||
      !['queued', 'running', 'awaiting_delivery'].includes(attempt.state) ||
      !deployment.agentId ||
      !deployment.conversationId ||
      attempt.deploymentVersion !== deployment.version
    ) {
      return attempt;
    }
    const [agent] = await this.db
      .select({
        currentConfigVersionId: schema.agentsPostgres.currentConfigVersionId,
      })
      .from(schema.agentsPostgres)
      .where(eq(schema.agentsPostgres.id, deployment.agentId))
      .limit(1);
    let [run] = await this.db
      .select()
      .from(schema.agentRunsPostgres)
      .where(
        and(
          eq(schema.agentRunsPostgres.appId, deployment.appId),
          eq(schema.agentRunsPostgres.agentId, deployment.agentId),
          eq(
            schema.agentRunsPostgres.conversationId,
            deployment.conversationId,
          ),
          attempt.runId
            ? eq(schema.agentRunsPostgres.id, attempt.runId)
            : eq(schema.agentRunsPostgres.messageId, attempt.inboundMessageId),
          agent?.currentConfigVersionId
            ? eq(
                schema.agentRunsPostgres.configVersionId,
                agent.currentConfigVersionId,
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.agentRunsPostgres.createdAt))
      .limit(1);
    if (!run && !attempt.runId) {
      const [inboundMessage] = await this.db
        .select({ threadId: schema.messagesPostgres.threadId })
        .from(schema.messagesPostgres)
        .where(eq(schema.messagesPostgres.id, attempt.inboundMessageId))
        .limit(1);
      if (!inboundMessage) return attempt;
      const candidates = await this.db
        .select()
        .from(schema.agentRunsPostgres)
        .where(
          and(
            eq(schema.agentRunsPostgres.appId, deployment.appId),
            eq(schema.agentRunsPostgres.agentId, deployment.agentId),
            eq(
              schema.agentRunsPostgres.conversationId,
              deployment.conversationId,
            ),
            inboundMessage.threadId
              ? eq(schema.agentRunsPostgres.threadId, inboundMessage.threadId)
              : isNull(schema.agentRunsPostgres.threadId),
            gte(schema.agentRunsPostgres.createdAt, attempt.updatedAt),
            agent?.currentConfigVersionId
              ? eq(
                  schema.agentRunsPostgres.configVersionId,
                  agent.currentConfigVersionId,
                )
              : undefined,
          ),
        )
        .orderBy(desc(schema.agentRunsPostgres.createdAt))
        .limit(2);
      if (candidates.length === 1) [run] = candidates;
    }
    if (!run) return attempt;
    if (run.status === 'failed' || run.status === 'canceled') {
      return this.updateAttempt(attempt.id, {
        state: 'failed',
        runId: run.id,
      });
    }
    if (run.status !== 'completed') {
      return this.updateAttempt(attempt.id, {
        state: 'running',
        runId: run.id,
      });
    }
    const [delivery] = await this.db
      .select()
      .from(schema.outboundDeliveriesPostgres)
      .where(
        and(
          eq(schema.outboundDeliveriesPostgres.appId, deployment.appId),
          eq(schema.outboundDeliveriesPostgres.agentId, deployment.agentId),
          eq(schema.outboundDeliveriesPostgres.runId, run.id),
          eq(
            schema.outboundDeliveriesPostgres.conversationId,
            deployment.conversationId,
          ),
        ),
      )
      .orderBy(desc(schema.outboundDeliveriesPostgres.createdAt))
      .limit(1);
    let deliveryProofId: string | null = delivery?.id ?? null;
    let delivered = false;
    if (delivery) {
      const [finalAnswer] = await this.db
        .select()
        .from(schema.outboundDeliveryFinalAnswersPostgres)
        .where(
          eq(
            schema.outboundDeliveryFinalAnswersPostgres.deliveryId,
            delivery.id,
          ),
        )
        .limit(1);
      const items = await this.db
        .select()
        .from(schema.outboundDeliveryItemsPostgres)
        .where(
          eq(schema.outboundDeliveryItemsPostgres.deliveryId, delivery.id),
        );
      const receipts = items.length
        ? await this.db
            .select()
            .from(schema.outboundDeliveryReceiptsPostgres)
            .where(
              inArray(
                schema.outboundDeliveryReceiptsPostgres.itemId,
                items.map((item) => item.id),
              ),
            )
        : [];
      const receiptItemIds = new Set(
        receipts
          .filter((receipt) => Boolean(receipt.providerMessageId))
          .map((receipt) => receipt.itemId),
      );
      delivered =
        Boolean(finalAnswer) &&
        finalAnswer!.segmentCount === items.length &&
        items.length > 0 &&
        items.every(
          (item) => item.status === 'sent' && receiptItemIds.has(item.id),
        );
    } else {
      const streamedReceipts = await this.db
        .select({ id: schema.messagesPostgres.id })
        .from(schema.messagesPostgres)
        .where(
          and(
            eq(schema.messagesPostgres.appId, deployment.appId),
            eq(
              schema.messagesPostgres.conversationId,
              deployment.conversationId,
            ),
            eq(schema.messagesPostgres.direction, 'outbound'),
            eq(schema.messagesPostgres.deliveryStatus, 'sent'),
            isNotNull(schema.messagesPostgres.deliveredAt),
            gte(schema.messagesPostgres.createdAt, run.createdAt),
            run.endedAt
              ? lte(schema.messagesPostgres.createdAt, run.endedAt)
              : undefined,
          ),
        )
        .limit(2);
      if (streamedReceipts.length === 1) {
        delivered = true;
        deliveryProofId = streamedReceipts[0]!.id;
      }
    }
    if (!delivered) {
      return this.updateAttempt(attempt.id, {
        state: 'awaiting_delivery',
        runId: run.id,
        deliveryId: deliveryProofId,
      });
    }
    const now = new Date().toISOString();
    return this.db.transaction(async (tx) => {
      const [succeeded] = await tx
        .update(schema.onboardingVerificationAttemptsPostgres)
        .set({
          state: 'succeeded',
          runId: run.id,
          deliveryId: deliveryProofId,
          succeededAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.onboardingVerificationAttemptsPostgres.id, attempt.id),
            eq(
              schema.onboardingVerificationAttemptsPostgres.deploymentVersion,
              deployment.version,
            ),
            sql`${schema.onboardingVerificationAttemptsPostgres.state} IN ('queued', 'running', 'awaiting_delivery')`,
          ),
        )
        .returning();
      if (!succeeded) return attempt;
      await tx
        .update(schema.onboardingDeploymentsPostgres)
        .set({ state: 'ready', readyAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.onboardingDeploymentsPostgres.id, deployment.id),
            eq(
              schema.onboardingDeploymentsPostgres.version,
              deployment.version,
            ),
            eq(
              schema.onboardingDeploymentsPostgres.state,
              'verification_required',
            ),
          ),
        );
      return succeeded;
    });
  }

  private async updateAttempt(
    id: string,
    values: Partial<
      Pick<
        typeof schema.onboardingVerificationAttemptsPostgres.$inferInsert,
        'state' | 'runId' | 'deliveryId'
      >
    >,
  ) {
    const [row] = await this.db
      .update(schema.onboardingVerificationAttemptsPostgres)
      .set({ ...values, updatedAt: new Date().toISOString() })
      .where(eq(schema.onboardingVerificationAttemptsPostgres.id, id))
      .returning();
    return row!;
  }
}
