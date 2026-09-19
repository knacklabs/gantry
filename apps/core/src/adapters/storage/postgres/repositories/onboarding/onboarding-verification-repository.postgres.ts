import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { stableSha256Json } from '../../../../../shared/stable-hash.js';
import type { CanonicalDb } from '../canonical-graph-repository.postgres.js';
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
      .select({ state: d.state })
      .from(d)
      .where(
        and(
          eq(d.appId, input.appId),
          eq(d.agentId, input.agentId),
          eq(d.providerAccountId, input.providerAccountId),
          eq(d.conversationId, input.conversationId),
        ),
      )
      .limit(1);
    if (!deployment || deployment.state === 'ready') {
      return { attemptId: null, blocked: false };
    }
    const rows = await this.db
      .select({ id: a.id, challengeText: a.challengeText })
      .from(a)
      .innerJoin(d, eq(d.id, a.deploymentId))
      .innerJoin(
        aliases,
        and(
          eq(aliases.appId, d.appId),
          eq(aliases.userId, d.approverPersonId),
          eq(aliases.provider, 'slack'),
          eq(aliases.providerAccountId, d.providerAccountId),
          eq(aliases.externalUserId, input.senderExternalUserId),
          eq(aliases.verificationStatus, 'verified'),
          sql`${aliases.retiredAt} IS NULL`,
        ),
      )
      .where(
        and(
          eq(d.appId, input.appId),
          eq(d.agentId, input.agentId),
          eq(d.providerAccountId, input.providerAccountId),
          eq(d.conversationId, input.conversationId),
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
    const [row] = await this.db
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
          eq(schema.onboardingVerificationAttemptsPostgres.id, input.attemptId),
          eq(
            schema.onboardingVerificationAttemptsPostgres.state,
            'waiting_for_message',
          ),
          sql`${schema.onboardingVerificationAttemptsPostgres.expiresAt} > now()`,
        ),
      )
      .returning({ id: schema.onboardingVerificationAttemptsPostgres.id });
    return Boolean(row);
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
    const [run] = await this.db
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
          eq(schema.agentRunsPostgres.messageId, attempt.inboundMessageId),
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
    if (!delivery) {
      return this.updateAttempt(attempt.id, {
        state: 'awaiting_delivery',
        runId: run.id,
      });
    }
    const [finalAnswer] = await this.db
      .select()
      .from(schema.outboundDeliveryFinalAnswersPostgres)
      .where(
        eq(schema.outboundDeliveryFinalAnswersPostgres.deliveryId, delivery.id),
      )
      .limit(1);
    const items = await this.db
      .select()
      .from(schema.outboundDeliveryItemsPostgres)
      .where(eq(schema.outboundDeliveryItemsPostgres.deliveryId, delivery.id));
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
    const delivered =
      Boolean(finalAnswer) &&
      finalAnswer!.segmentCount === items.length &&
      items.length > 0 &&
      items.every(
        (item) => item.status === 'sent' && receiptItemIds.has(item.id),
      );
    if (!delivered) {
      return this.updateAttempt(attempt.id, {
        state: 'awaiting_delivery',
        runId: run.id,
        deliveryId: delivery.id,
      });
    }
    const now = new Date().toISOString();
    return this.db.transaction(async (tx) => {
      const [succeeded] = await tx
        .update(schema.onboardingVerificationAttemptsPostgres)
        .set({
          state: 'succeeded',
          runId: run.id,
          deliveryId: delivery.id,
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
