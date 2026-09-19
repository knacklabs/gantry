import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import {
  ONBOARDING_CANDIDATE_TTL_MS,
  assertCandidateTransition,
  type OnboardingCandidateState,
} from '../../../../../application/onboarding/onboarding-state-machine.js';
import type { ModelCredentialProvider } from '../../../../../domain/model-credentials/model-credentials.js';
import {
  getModelProviderDefinition,
  normalizeModelCredentialPayload,
  resolveModelCredentialMode,
  type ModelCredentialPayload,
} from '../../../../../shared/model-provider-registry.js';
import { stableSha256Json } from '../../../../../shared/stable-hash.js';
import type { CanonicalDb } from '../canonical-graph-repository.postgres.js';
import {
  decryptCredentialSecretValue,
  encryptCredentialSecretValue,
} from '../credential-secret-crypto.js';
import * as schema from '../../schema/schema.js';
import type { OnboardingDeploymentRepository } from './onboarding-deployment-repository.postgres.js';

export class OnboardingCandidateRepository {
  constructor(
    private readonly db: CanonicalDb,
    private readonly deployments: OnboardingDeploymentRepository,
  ) {}

  async stageModelCredentialCandidate(input: {
    appId: string;
    userId: string;
    providerId: string;
    authMode?: string;
    payload: unknown;
  }) {
    const provider = getModelProviderDefinition(input.providerId);
    if (!provider)
      throw new Error(`Unsupported model provider: ${input.providerId}`);
    const mode = resolveModelCredentialMode(provider, input.authMode);
    const payload = normalizeModelCredentialPayload({
      providerId: input.providerId as ModelCredentialProvider,
      authMode: mode.id,
      payload: input.payload,
    });
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + ONBOARDING_CANDIDATE_TTL_MS,
    ).toISOString();
    const requestHash = stableSha256Json({
      providerId: input.providerId,
      authMode: mode.id,
      payload,
    });
    const payloadEncrypted = encryptCredentialSecretValue(
      JSON.stringify(payload),
      candidateAad(input.appId, id, mode.id, mode.version),
    );
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.onboardingModelCandidatesPostgres)
        .set({ state: 'cancelled', updatedAt: now.toISOString() })
        .where(
          and(
            eq(schema.onboardingModelCandidatesPostgres.appId, input.appId),
            eq(schema.onboardingModelCandidatesPostgres.userId, input.userId),
            sql`${schema.onboardingModelCandidatesPostgres.state} IN ('staged', 'validating', 'checked', 'verified')`,
          ),
        );
      await tx.insert(schema.onboardingModelCandidatesPostgres).values({
        id,
        appId: input.appId,
        userId: input.userId,
        providerId: input.providerId,
        authMode: mode.id,
        modelAlias: null,
        routeId: null,
        payloadEncrypted,
        requestHash,
        expiresAt,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      const deployment = await this.deployments.ensureDeploymentWith(tx, input);
      await tx
        .update(schema.onboardingDeploymentsPostgres)
        .set({
          modelCandidateId: id,
          providerAccountCandidateId: null,
          providerAccountId: null,
          conversationId: null,
          approverPersonId: null,
          desiredStateRevision: null,
          readyAt: null,
          state: 'setup_incomplete',
          currentStep: 1,
          version: deployment.version + (deployment.agentId ? 1 : 0),
          updatedAt: now.toISOString(),
        })
        .where(eq(schema.onboardingDeploymentsPostgres.id, deployment.id));
    });
    return {
      id,
      providerId: input.providerId,
      authMode: mode.id,
      state: 'staged' as const,
      expiresAt,
    };
  }

  async getModelCredentialCandidate(input: {
    appId: string;
    userId: string;
    id: string;
  }) {
    const [row] = await this.db
      .select()
      .from(schema.onboardingModelCandidatesPostgres)
      .where(
        and(
          eq(schema.onboardingModelCandidatesPostgres.id, input.id),
          eq(schema.onboardingModelCandidatesPostgres.appId, input.appId),
          eq(schema.onboardingModelCandidatesPostgres.userId, input.userId),
        ),
      )
      .limit(1);
    if (!row) return null;
    const provider = getModelProviderDefinition(row.providerId);
    if (!provider)
      throw new Error(`Unsupported model provider: ${row.providerId}`);
    const mode = resolveModelCredentialMode(provider, row.authMode);
    const payload = JSON.parse(
      decryptCredentialSecretValue(
        row.payloadEncrypted,
        candidateAad(row.appId, row.id, row.authMode, mode.version),
      ),
    ) as ModelCredentialPayload;
    return { ...row, payload, schemaVersion: mode.version };
  }

  async transitionModelCredentialCandidate(input: {
    appId: string;
    userId: string;
    id: string;
    state: OnboardingCandidateState;
    checks?: unknown[];
    failureCode?: string | null;
    verifiedAt?: string | null;
    verificationExpiresAt?: string | null;
  }) {
    const [current] = await this.db
      .select({ state: schema.onboardingModelCandidatesPostgres.state })
      .from(schema.onboardingModelCandidatesPostgres)
      .where(
        and(
          eq(schema.onboardingModelCandidatesPostgres.id, input.id),
          eq(schema.onboardingModelCandidatesPostgres.appId, input.appId),
          eq(schema.onboardingModelCandidatesPostgres.userId, input.userId),
        ),
      )
      .limit(1);
    if (!current) return null;
    assertCandidateTransition(
      current.state as OnboardingCandidateState,
      input.state,
    );
    const [row] = await this.db
      .update(schema.onboardingModelCandidatesPostgres)
      .set({
        state: input.state,
        ...(input.checks ? { checksJson: input.checks } : {}),
        ...(input.failureCode !== undefined
          ? { failureCode: input.failureCode }
          : {}),
        ...(input.verifiedAt !== undefined
          ? { verifiedAt: input.verifiedAt }
          : {}),
        ...(input.verificationExpiresAt !== undefined
          ? { verificationExpiresAt: input.verificationExpiresAt }
          : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(schema.onboardingModelCandidatesPostgres.id, input.id),
          eq(schema.onboardingModelCandidatesPostgres.appId, input.appId),
          eq(schema.onboardingModelCandidatesPostgres.userId, input.userId),
          eq(schema.onboardingModelCandidatesPostgres.state, current.state),
        ),
      )
      .returning();
    return row ?? null;
  }

  async bindModelSelectionForVerification(input: {
    appId: string;
    userId: string;
    id: string;
    modelAlias: string;
    routeId: string;
  }) {
    const [current] = await this.db
      .select({ state: schema.onboardingModelCandidatesPostgres.state })
      .from(schema.onboardingModelCandidatesPostgres)
      .where(
        and(
          eq(schema.onboardingModelCandidatesPostgres.id, input.id),
          eq(schema.onboardingModelCandidatesPostgres.appId, input.appId),
          eq(schema.onboardingModelCandidatesPostgres.userId, input.userId),
        ),
      )
      .limit(1);
    if (!current) return null;
    const currentState = current.state as OnboardingCandidateState;
    assertCandidateTransition(currentState, 'validating');
    const [row] = await this.db
      .update(schema.onboardingModelCandidatesPostgres)
      .set({
        modelAlias: input.modelAlias,
        routeId: input.routeId,
        state: 'validating',
        checksJson: [],
        failureCode: null,
        verifiedAt: null,
        verificationExpiresAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(schema.onboardingModelCandidatesPostgres.id, input.id),
          eq(schema.onboardingModelCandidatesPostgres.appId, input.appId),
          eq(schema.onboardingModelCandidatesPostgres.userId, input.userId),
          eq(schema.onboardingModelCandidatesPostgres.state, current.state),
        ),
      )
      .returning();
    return row ?? null;
  }

  async stageSlackWorkspaceCandidate(input: {
    appId: string;
    userId: string;
    agentId: string;
    providerId: 'slack';
    credentials: Record<string, string>;
  }) {
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + ONBOARDING_CANDIDATE_TTL_MS,
    ).toISOString();
    const requestHash = stableSha256Json({
      providerId: input.providerId,
      credentials: input.credentials,
    });
    const payloadEncrypted = encryptCredentialSecretValue(
      JSON.stringify(input.credentials),
      candidateAad(input.appId, id, 'slack_tokens', 1),
    );
    await this.db.transaction(async (tx) => {
      const deployment = await this.deployments.ensureDeploymentWith(tx, input);
      if (deployment.agentId !== input.agentId) {
        throw new Error(
          'The Slack candidate does not belong to this onboarding agent.',
        );
      }
      await tx
        .update(schema.onboardingProviderCandidatesPostgres)
        .set({ state: 'cancelled', updatedAt: now.toISOString() })
        .where(
          and(
            eq(schema.onboardingProviderCandidatesPostgres.appId, input.appId),
            eq(
              schema.onboardingProviderCandidatesPostgres.userId,
              input.userId,
            ),
            sql`${schema.onboardingProviderCandidatesPostgres.state} IN ('staged', 'validating', 'verified')`,
          ),
        );
      await tx.insert(schema.onboardingProviderCandidatesPostgres).values({
        id,
        appId: input.appId,
        userId: input.userId,
        agentId: input.agentId,
        providerId: input.providerId,
        payloadEncrypted,
        requestHash,
        expiresAt,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      await tx
        .update(schema.onboardingDeploymentsPostgres)
        .set({
          providerAccountCandidateId: id,
          providerAccountId: null,
          conversationId: null,
          approverPersonId: null,
          readyAt: null,
          state: 'setup_incomplete',
          currentStep: 2,
          version: deployment.version + (deployment.providerAccountId ? 1 : 0),
          updatedAt: now.toISOString(),
        })
        .where(eq(schema.onboardingDeploymentsPostgres.id, deployment.id));
    });
    return {
      id,
      providerId: input.providerId,
      state: 'staged' as const,
      expiresAt,
    };
  }

  async getSlackWorkspaceCandidate(input: {
    appId: string;
    userId: string;
    id: string;
  }) {
    const [row] = await this.db
      .select()
      .from(schema.onboardingProviderCandidatesPostgres)
      .where(
        and(
          eq(schema.onboardingProviderCandidatesPostgres.id, input.id),
          eq(schema.onboardingProviderCandidatesPostgres.appId, input.appId),
          eq(schema.onboardingProviderCandidatesPostgres.userId, input.userId),
        ),
      )
      .limit(1);
    if (!row) return null;
    const credentials = JSON.parse(
      decryptCredentialSecretValue(
        row.payloadEncrypted,
        candidateAad(row.appId, row.id, 'slack_tokens', 1),
      ),
    ) as Record<string, string>;
    return { ...row, credentials };
  }

  async transitionSlackWorkspaceCandidate(input: {
    appId: string;
    userId: string;
    id: string;
    state: OnboardingCandidateState;
    checks?: unknown[];
    externalIdentity?: unknown;
    failureCode?: string | null;
    verifiedAt?: string | null;
  }) {
    const [current] = await this.db
      .select({ state: schema.onboardingProviderCandidatesPostgres.state })
      .from(schema.onboardingProviderCandidatesPostgres)
      .where(
        and(
          eq(schema.onboardingProviderCandidatesPostgres.id, input.id),
          eq(schema.onboardingProviderCandidatesPostgres.appId, input.appId),
          eq(schema.onboardingProviderCandidatesPostgres.userId, input.userId),
        ),
      )
      .limit(1);
    if (!current) return null;
    assertCandidateTransition(
      current.state as OnboardingCandidateState,
      input.state,
    );
    const [row] = await this.db
      .update(schema.onboardingProviderCandidatesPostgres)
      .set({
        state: input.state,
        ...(input.checks ? { checksJson: input.checks } : {}),
        ...(input.externalIdentity !== undefined
          ? { externalIdentityJson: input.externalIdentity }
          : {}),
        ...(input.failureCode !== undefined
          ? { failureCode: input.failureCode }
          : {}),
        ...(input.verifiedAt !== undefined
          ? { verifiedAt: input.verifiedAt }
          : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(schema.onboardingProviderCandidatesPostgres.id, input.id),
          eq(schema.onboardingProviderCandidatesPostgres.appId, input.appId),
          eq(schema.onboardingProviderCandidatesPostgres.userId, input.userId),
          eq(schema.onboardingProviderCandidatesPostgres.state, current.state),
        ),
      )
      .returning();
    return row ?? null;
  }

  async recordSlackWorkspaceActivation(input: {
    appId: string;
    userId: string;
    candidateId: string;
    providerAccountId: string;
    desiredStateRevision: number;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      const deployment = await this.deployments.ensureDeploymentWith(tx, input);
      await tx
        .update(schema.onboardingProviderCandidatesPostgres)
        .set({ state: 'activated', updatedAt: now })
        .where(
          and(
            eq(
              schema.onboardingProviderCandidatesPostgres.id,
              input.candidateId,
            ),
            eq(schema.onboardingProviderCandidatesPostgres.appId, input.appId),
          ),
        );
      await tx
        .update(schema.onboardingDeploymentsPostgres)
        .set({
          providerAccountId: input.providerAccountId,
          currentStep: 3,
          desiredStateRevision: input.desiredStateRevision,
          state: 'projection_pending',
          updatedAt: now,
        })
        .where(eq(schema.onboardingDeploymentsPostgres.id, deployment.id));
    });
  }
}

function candidateAad(
  appId: string,
  id: string,
  authMode: string,
  schemaVersion: number,
) {
  return {
    appId,
    subjectKind: 'onboarding_candidate' as const,
    subjectId: id,
    authMode,
    schemaVersion,
  };
}
