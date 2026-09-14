import { randomUUID } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';
import { ApplicationError } from '../../../../application/common/application-error.js';
import type {
  CreateOnboardingSetupRequestDto,
  OnboardingProgress,
  OnboardingSetupResponseDto,
} from '../../../../application/onboarding/onboarding-setup.dto.js';
import type { OnboardingSetupRepository } from '../../../../application/onboarding/onboarding-setup-repository.interface.js';
import type { AgentId } from '../../../../domain/agent/agent.js';
import type { AppId } from '../../../../domain/app/app.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import { stableId } from './person-identity-mappers.postgres.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { PostgresRuntimeEventRepository } from './runtime-event-repository.postgres.js';
import {
  agentConfigVersionsPostgres,
  agentsPostgres,
  appsPostgres,
  customRolesPostgres,
  onboardingSetupsPostgres,
  settingsRevisionsPostgres,
  usersPostgres,
} from '../schema/schema.js';

export class PostgresOnboardingSetupRepository implements OnboardingSetupRepository {
  constructor(private readonly db: CanonicalDb) {}

  async createOrResume(
    input: CreateOnboardingSetupRequestDto & { requestHash: string },
  ): Promise<OnboardingSetupResponseDto> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${appsPostgres.id} from ${appsPostgres} where ${appsPostgres.id} = ${input.appId} for update`,
      );
      const [existing] = await tx
        .select()
        .from(onboardingSetupsPostgres)
        .where(eq(onboardingSetupsPostgres.appId, input.appId))
        .limit(1);
      if (existing) {
        if (
          existing.idempotencyKey !== input.idempotencyKey ||
          existing.requestHash !== input.requestHash
        ) {
          throw new ApplicationError(
            'CONFLICT',
            'This app already has an onboarding setup with different details.',
          );
        }
        const [agent] = await tx
          .select({ name: agentsPostgres.name })
          .from(agentsPostgres)
          .where(eq(agentsPostgres.id, existing.agentId))
          .limit(1);
        if (!agent) {
          throw new ApplicationError(
            'CONFLICT',
            'The existing onboarding setup is incomplete.',
          );
        }
        return {
          setupId: existing.id,
          agentId: existing.agentId,
          agentName: agent.name,
          desiredStateRevision: existing.desiredStateRevision,
          replayed: true,
        };
      }

      const now = new Date().toISOString();
      const setupId = randomUUID();
      const agentId = `agent:${randomUUID()}`;
      const roleId = `custom-role:${randomUUID()}`;
      const configId = `agent-config:${randomUUID()}`;
      const roleName = `${input.name} — ${input.title}`;
      const rolePrompt = [
        `You are the organisation's ${input.title}.`,
        '',
        'Responsibilities:',
        ...input.responsibilities.map((item) => `- ${item}`),
      ].join('\n');
      const [latestRevision] = await tx
        .select()
        .from(settingsRevisionsPostgres)
        .where(eq(settingsRevisionsPostgres.appId, input.appId))
        .orderBy(desc(settingsRevisionsPostgres.revision))
        .limit(1);
      const revision = (latestRevision?.revision ?? 0) + 1;
      const priorDocument = isRecord(latestRevision?.settingsDocumentJson)
        ? latestRevision.settingsDocumentJson
        : {};
      const priorAgents = isRecord(priorDocument.agents)
        ? priorDocument.agents
        : {};
      const folder = agentId.replace(/^agent:/, '');

      await tx.insert(customRolesPostgres).values({
        id: roleId,
        appId: input.appId,
        name: roleName,
        prompt: rolePrompt,
        sourceRoleId: null,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(agentsPostgres).values({
        id: agentId,
        appId: input.appId,
        name: input.name,
        status: 'active',
        currentConfigVersionId: configId,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(usersPostgres).values({
        id: stableId('person', [input.appId, 'service', agentId]),
        appId: input.appId,
        agentId,
        kind: 'service',
        displayName: input.name,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(agentConfigVersionsPostgres).values({
        id: configId,
        appId: input.appId,
        agentId,
        version: 1,
        promptProfileRef: 'browser-agent-role-snapshot',
        agentNameSnapshot: input.name,
        roleDisplayName: roleName,
        rolePrompt,
        sourceRoleId: roleId,
        modelAliasSnapshot: input.modelAlias,
        llmProfileId: 'llm:default',
        toolIdsJson: '[]',
        skillIdsJson: '[]',
        permissionPolicyIdsJson: '[]',
        runtimeLimitsJson: '{}',
        createdAt: now,
      });
      await tx.insert(settingsRevisionsPostgres).values({
        appId: input.appId,
        revision,
        settingsDocumentJson: {
          ...priorDocument,
          agents: {
            ...priorAgents,
            [folder]: {
              ...(isRecord(priorAgents[folder]) ? priorAgents[folder] : {}),
              name: input.name,
              model: input.modelAlias,
              agentHarness: input.agentHarness,
            },
          },
        },
        minReaderVersion: latestRevision?.minReaderVersion ?? 0,
        createdBy: `browser:${input.actorId}`,
        note: 'First-agent onboarding setup',
        createdAt: now,
      });
      await new PostgresRuntimeEventRepository(
        this.db,
      ).appendRuntimeEventWithExecutor(tx, {
        appId: input.appId as AppId,
        agentId: agentId as AgentId,
        eventType: RUNTIME_EVENT_TYPES.ONBOARDING_SETUP_CREATED,
        actor: { kind: 'human', personId: input.actorId },
        idempotencyKey: `onboarding-setup:${setupId}`,
        payload: { setupId, revision },
        createdAt: now,
      });
      await tx.insert(onboardingSetupsPostgres).values({
        id: setupId,
        appId: input.appId,
        agentId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        desiredStateRevision: revision,
        progressJson: { modelValidated: true },
        createdBy: input.actorId,
        updatedBy: input.actorId,
        createdAt: now,
        updatedAt: now,
      });
      return {
        setupId,
        agentId,
        agentName: input.name,
        desiredStateRevision: revision,
        replayed: false,
      };
    });
  }

  async updateProgress(input: {
    appId: CreateOnboardingSetupRequestDto['appId'];
    setupId: string;
    actorId: string;
    progress: OnboardingProgress;
  }): Promise<void> {
    const result = await this.db
      .update(onboardingSetupsPostgres)
      .set({
        progressJson: input.progress,
        updatedBy: input.actorId,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(onboardingSetupsPostgres.id, input.setupId),
          eq(onboardingSetupsPostgres.appId, input.appId),
        ),
      )
      .returning({ id: onboardingSetupsPostgres.id });
    if (result.length === 0) {
      throw new ApplicationError('NOT_FOUND', 'Onboarding setup not found.');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
