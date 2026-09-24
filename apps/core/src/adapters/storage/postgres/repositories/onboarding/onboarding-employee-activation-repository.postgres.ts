import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import {
  fingerprintCredential,
  fingerprintCredentialPayload,
} from '../../../../../application/model-credentials/model-credential-service.js';
import {
  getModelProviderDefinition,
  resolveModelCredentialMode,
} from '../../../../../shared/model-provider-registry.js';
import {
  configVersionIdForAgent,
  type CanonicalDb,
} from '../canonical-graph-repository.postgres.js';
import { encryptCredentialSecretValue } from '../credential-secret-crypto.js';
import { stableId } from '../person-identity-mappers.postgres.js';
import { PostgresSettingsRevisionRepository } from '../settings-revision-repository.postgres.js';
import * as schema from '../../schema/schema.js';
import type { OnboardingCandidateRepository } from './onboarding-candidate-repository.postgres.js';
import type { OnboardingDeploymentRepository } from './onboarding-deployment-repository.postgres.js';

export class OnboardingEmployeeActivationRepository {
  constructor(
    private readonly db: CanonicalDb,
    private readonly candidates: OnboardingCandidateRepository,
    private readonly deployments: OnboardingDeploymentRepository,
  ) {}

  async activateModelAndCreateEmployee(input: {
    appId: string;
    userId: string;
    candidateId: string;
    name: string;
    title: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh';
    responsibilities: string[];
  }) {
    const candidate = await this.candidates.getModelCredentialCandidate({
      appId: input.appId,
      userId: input.userId,
      id: input.candidateId,
    });
    if (
      !candidate ||
      (candidate.state !== 'verified' && candidate.state !== 'activated')
    ) {
      throw new Error('A verified model candidate is required.');
    }
    if (!candidate.modelAlias || !candidate.routeId) {
      throw new Error('The verified model selection is missing.');
    }
    const modelAlias = candidate.modelAlias;
    const now = new Date().toISOString();
    if (
      candidate.state === 'verified' &&
      (!candidate.verificationExpiresAt ||
        Date.parse(candidate.verificationExpiresAt) <= Date.now())
    ) {
      throw new Error(
        'The model verification receipt expired. Test the model again.',
      );
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${schema.appsPostgres.id} from ${schema.appsPostgres} where ${schema.appsPostgres.id} = ${input.appId} for update`,
      );
      const deployment = await this.deployments.ensureDeploymentWith(tx, input);
      if (deployment.agentId) {
        const [agent] = await tx
          .select()
          .from(schema.agentsPostgres)
          .where(eq(schema.agentsPostgres.id, deployment.agentId))
          .limit(1);
        return {
          agentId: deployment.agentId,
          name: agent?.name ?? input.name,
          version: deployment.version,
          desiredStateRevision: deployment.desiredStateRevision ?? undefined,
          replayed: true,
        };
      }
      if (candidate.state === 'activated') {
        throw new Error(
          'Activated model candidate has no employee deployment.',
        );
      }
      const agentId = `agent:${randomUUID()}`;
      const roleId = `custom-role:${randomUUID()}`;
      const configId = configVersionIdForAgent(agentId);
      const llmProfileId = `llm:onboarding:${randomUUID()}`;
      const roleName = `${input.name.trim()} — ${input.title.trim()}`;
      const rolePrompt = [
        `You are the organisation's ${input.title.trim()}.`,
        '',
        'Responsibilities:',
        ...input.responsibilities
          .map((item) => `- ${item.trim()}`)
          .filter((item) => item !== '- '),
      ].join('\n');
      await tx.insert(schema.customRolesPostgres).values({
        id: roleId,
        appId: input.appId,
        name: roleName,
        prompt: rolePrompt,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(schema.agentsPostgres).values({
        id: agentId,
        appId: input.appId,
        name: input.name.trim(),
        status: 'active',
        currentConfigVersionId: configId,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(schema.usersPostgres).values({
        id: stableId('person', [input.appId, 'service', agentId]),
        appId: input.appId,
        agentId,
        kind: 'service',
        displayName: input.name.trim(),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const provider = getModelProviderDefinition(candidate.providerId)!;
      await tx.insert(schema.llmProfilesPostgres).values({
        id: llmProfileId,
        appId: input.appId,
        purpose: 'default',
        responseFamily: provider.responseFamily,
        modelAlias,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(schema.agentConfigVersionsPostgres).values({
        id: configId,
        appId: input.appId,
        agentId,
        version: 1,
        promptProfileRef: 'browser-agent-role-snapshot',
        agentNameSnapshot: input.name.trim(),
        roleDisplayName: roleName,
        rolePrompt,
        sourceRoleId: roleId,
        modelAliasSnapshot: modelAlias,
        llmProfileId,
        toolIdsJson: '[]',
        skillIdsJson: '[]',
        permissionPolicyIdsJson: '[]',
        runtimeLimitsJson: '{}',
        createdAt: now,
      });
      const fields = resolveModelCredentialMode(
        provider,
        candidate.authMode,
      ).fields;
      const existing = await tx
        .select({ revision: schema.modelCredentialsPostgres.revision })
        .from(schema.modelCredentialsPostgres)
        .where(
          and(
            eq(schema.modelCredentialsPostgres.appId, input.appId),
            eq(
              schema.modelCredentialsPostgres.providerId,
              candidate.providerId,
            ),
          ),
        )
        .limit(1);
      await tx
        .insert(schema.modelCredentialsPostgres)
        .values({
          id: `model-credential:${input.appId}:${candidate.providerId}`,
          appId: input.appId,
          providerId: candidate.providerId,
          authMode: candidate.authMode,
          schemaVersion: candidate.schemaVersion,
          payloadEncrypted: encryptCredentialSecretValue(
            JSON.stringify(candidate.payload),
            {
              appId: input.appId,
              subjectKind: 'model_credential',
              subjectId: candidate.providerId,
              authMode: candidate.authMode,
              schemaVersion: candidate.schemaVersion,
            },
          ),
          fingerprint: fingerprintCredentialPayload(candidate.payload),
          fieldFingerprintsJson: JSON.stringify(
            fields
              .filter((field) => candidate.payload[field.name])
              .map((field) => ({
                field: field.name,
                fingerprint: fingerprintCredential(
                  candidate.payload[field.name]!,
                ),
              })),
          ),
          status: 'active',
          revision: (existing[0]?.revision ?? 0) + 1,
          createdBy: `browser:${input.userId}`,
          updatedBy: `browser:${input.userId}`,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.modelCredentialsPostgres.appId,
            schema.modelCredentialsPostgres.providerId,
          ],
          set: {
            authMode: candidate.authMode,
            schemaVersion: candidate.schemaVersion,
            payloadEncrypted: encryptCredentialSecretValue(
              JSON.stringify(candidate.payload),
              {
                appId: input.appId,
                subjectKind: 'model_credential',
                subjectId: candidate.providerId,
                authMode: candidate.authMode,
                schemaVersion: candidate.schemaVersion,
              },
            ),
            fingerprint: fingerprintCredentialPayload(candidate.payload),
            fieldFingerprintsJson: JSON.stringify(
              fields
                .filter((field) => candidate.payload[field.name])
                .map((field) => ({
                  field: field.name,
                  fingerprint: fingerprintCredential(
                    candidate.payload[field.name]!,
                  ),
                })),
            ),
            status: 'active',
            revision: (existing[0]?.revision ?? 0) + 1,
            updatedBy: `browser:${input.userId}`,
            updatedAt: now,
          },
        });
      const settings = new PostgresSettingsRevisionRepository(this.db);
      const latest = await settings.getLatestSettingsRevision(input.appId);
      const prior = latest?.settingsDocument ?? {};
      const agents = isRecord(prior.agents) ? prior.agents : {};
      const folder = agentId.replace(/^agent:/, '');
      const appended = await settings.appendSettingsRevisionWithExecutor(tx, {
        appId: input.appId,
        settingsDocument: {
          ...prior,
          agents: {
            ...agents,
            [folder]: {
              name: input.name.trim(),
              model: modelAlias,
              ...(input.effort ? { effort: input.effort } : {}),
            },
          },
        },
        minReaderVersion: latest?.minReaderVersion ?? 0,
        createdBy: `browser:${input.userId}`,
        note: 'Functional onboarding: create employee',
        expectedRevision: latest?.revision ?? 0,
        now,
      });
      if (appended.status !== 'appended')
        throw new Error('Settings changed while onboarding. Retry.');
      await tx
        .update(schema.onboardingModelCandidatesPostgres)
        .set({ state: 'activated', updatedAt: now })
        .where(eq(schema.onboardingModelCandidatesPostgres.id, candidate.id));
      await tx
        .update(schema.onboardingDeploymentsPostgres)
        .set({
          agentId,
          currentStep: 2,
          desiredStateRevision: appended.revision.revision,
          state: 'projection_pending',
          updatedAt: now,
        })
        .where(eq(schema.onboardingDeploymentsPostgres.id, deployment.id));
      return {
        agentId,
        name: input.name.trim(),
        version: deployment.version,
        desiredStateRevision: appended.revision.revision,
        replayed: false,
      };
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
