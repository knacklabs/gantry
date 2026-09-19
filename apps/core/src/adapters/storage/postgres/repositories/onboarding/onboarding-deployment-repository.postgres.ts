import { and, eq, sql } from 'drizzle-orm';

import {
  earliestOnboardingStep,
  type OnboardingCandidateState,
  type OnboardingDeploymentState,
} from '../../../../../application/onboarding/onboarding-state-machine.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from '../canonical-graph-repository.postgres.js';
import * as schema from '../../schema/schema.js';

export type OnboardingStatusProjection = {
  completed: boolean;
  deployment: null | {
    id: string;
    version: number;
    state: OnboardingDeploymentState;
    step: 1 | 2 | 3 | 4;
    agentId: string | null;
    providerAccountId: string | null;
    conversationId: string | null;
    approverPersonId: string | null;
    desiredStateRevision: number | null;
    readyAt: string | null;
    modelCandidate: null | {
      id: string;
      providerId: string;
      authMode: string;
      state: OnboardingCandidateState;
      modelAlias: string | null;
      expiresAt: string;
      verificationExpiresAt: string | null;
    };
  };
};

export class OnboardingDeploymentRepository {
  constructor(private readonly db: CanonicalDb) {}

  async status(input: {
    appId: string;
    userId: string;
    completedAt: string | null;
  }): Promise<OnboardingStatusProjection> {
    const [row] = await this.db
      .select()
      .from(schema.onboardingDeploymentsPostgres)
      .where(
        and(
          eq(schema.onboardingDeploymentsPostgres.appId, input.appId),
          eq(schema.onboardingDeploymentsPostgres.userId, input.userId),
        ),
      )
      .limit(1);
    if (!row)
      return { completed: input.completedAt !== null, deployment: null };
    const [modelCandidate] = row.modelCandidateId
      ? await this.db
          .select({
            id: schema.onboardingModelCandidatesPostgres.id,
            providerId: schema.onboardingModelCandidatesPostgres.providerId,
            authMode: schema.onboardingModelCandidatesPostgres.authMode,
            state: schema.onboardingModelCandidatesPostgres.state,
            modelAlias: schema.onboardingModelCandidatesPostgres.modelAlias,
            expiresAt: schema.onboardingModelCandidatesPostgres.expiresAt,
            verificationExpiresAt:
              schema.onboardingModelCandidatesPostgres.verificationExpiresAt,
          })
          .from(schema.onboardingModelCandidatesPostgres)
          .where(
            and(
              eq(
                schema.onboardingModelCandidatesPostgres.id,
                row.modelCandidateId,
              ),
              eq(schema.onboardingModelCandidatesPostgres.appId, input.appId),
              eq(schema.onboardingModelCandidatesPostgres.userId, input.userId),
            ),
          )
          .limit(1)
      : [];
    const state = row.state as OnboardingDeploymentState;
    return {
      completed: input.completedAt !== null,
      deployment: {
        id: row.id,
        version: row.version,
        state,
        step: earliestOnboardingStep({
          agentId: row.agentId,
          providerAccountId: row.providerAccountId,
          conversationId: row.conversationId,
          approverPersonId: row.approverPersonId,
          state,
        }),
        agentId: row.agentId,
        providerAccountId: row.providerAccountId,
        conversationId: row.conversationId,
        approverPersonId: row.approverPersonId,
        desiredStateRevision: row.desiredStateRevision,
        readyAt: row.readyAt,
        modelCandidate: modelCandidate
          ? {
              ...modelCandidate,
              state: modelCandidate.state as OnboardingCandidateState,
            }
          : null,
      },
    };
  }

  async ensureDeployment(input: { appId: string; userId: string }) {
    return this.ensureDeploymentWith(this.db, input);
  }

  async ensureDeploymentWith(
    executor: CanonicalExecutor,
    input: { appId: string; userId: string },
  ) {
    const [row] = await executor
      .insert(schema.onboardingDeploymentsPostgres)
      .values({ appId: input.appId, userId: input.userId })
      .onConflictDoUpdate({
        target: [
          schema.onboardingDeploymentsPostgres.appId,
          schema.onboardingDeploymentsPostgres.userId,
        ],
        set: {
          updatedAt: sql`${schema.onboardingDeploymentsPostgres.updatedAt}`,
        },
      })
      .returning();
    return row!;
  }

  async operationReplay(input: {
    appId: string;
    userId: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<{ statusCode: number; response: unknown } | null> {
    const [row] = await this.db
      .select()
      .from(schema.onboardingOperationsPostgres)
      .where(
        and(
          eq(schema.onboardingOperationsPostgres.appId, input.appId),
          eq(schema.onboardingOperationsPostgres.userId, input.userId),
          eq(schema.onboardingOperationsPostgres.operation, input.operation),
          eq(
            schema.onboardingOperationsPostgres.idempotencyKey,
            input.idempotencyKey,
          ),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (row.requestHash !== input.requestHash) {
      throw new Error('IDEMPOTENCY_CONFLICT');
    }
    return { statusCode: row.statusCode, response: row.responseJson };
  }

  async saveOperation(input: {
    appId: string;
    userId: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    statusCode: number;
    response: unknown;
  }): Promise<void> {
    await this.db.insert(schema.onboardingOperationsPostgres).values({
      appId: input.appId,
      userId: input.userId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      statusCode: input.statusCode,
      responseJson: input.response,
    });
  }

  async recordProjectionReceipt(input: {
    appId: string;
    revision: number;
    status: 'applied' | 'failed';
    failureCode?: string;
  }) {
    const now = new Date().toISOString();
    await this.db
      .insert(schema.settingsRevisionReceiptsPostgres)
      .values({
        appId: input.appId,
        revision: input.revision,
        status: input.status,
        failureCode: input.failureCode ?? null,
        appliedAt: input.status === 'applied' ? now : null,
      })
      .onConflictDoUpdate({
        target: [
          schema.settingsRevisionReceiptsPostgres.appId,
          schema.settingsRevisionReceiptsPostgres.revision,
        ],
        set: {
          status: input.status,
          failureCode: input.failureCode ?? null,
          appliedAt: input.status === 'applied' ? now : null,
        },
      });
    if (input.status === 'applied') {
      await this.db
        .update(schema.onboardingDeploymentsPostgres)
        .set({ state: 'verification_required', updatedAt: now })
        .where(
          and(
            eq(schema.onboardingDeploymentsPostgres.appId, input.appId),
            eq(
              schema.onboardingDeploymentsPostgres.desiredStateRevision,
              input.revision,
            ),
            eq(
              schema.onboardingDeploymentsPostgres.state,
              'projection_pending',
            ),
          ),
        );
    }
  }

  async recordSlackWorkAssignment(input: {
    appId: string;
    userId: string;
    conversationId: string;
    approverPersonId: string;
    desiredStateRevision: number;
  }) {
    const now = new Date().toISOString();
    const deployment = await this.ensureDeployment(input);
    const [row] = await this.db
      .update(schema.onboardingDeploymentsPostgres)
      .set({
        conversationId: input.conversationId,
        approverPersonId: input.approverPersonId,
        desiredStateRevision: input.desiredStateRevision,
        currentStep: 4,
        state: 'projection_pending',
        readyAt: null,
        version:
          deployment.conversationId === input.conversationId &&
          deployment.approverPersonId === input.approverPersonId
            ? deployment.version
            : deployment.version + 1,
        updatedAt: now,
      })
      .where(eq(schema.onboardingDeploymentsPostgres.id, deployment.id))
      .returning();
    return row!;
  }
}
