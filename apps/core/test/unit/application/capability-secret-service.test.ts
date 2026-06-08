import { describe, expect, it } from 'vitest';

import { CapabilitySecretService } from '@core/application/capability-secrets/capability-secret-service.js';
import { resolveSelectedSkillEnvForAgent } from '@core/application/capability-secrets/skill-secret-projection.js';
import type {
  CapabilitySecret,
  CapabilitySecretMetadata,
} from '@core/domain/capability-secrets/capability-secrets.js';
import type { AppId } from '@core/domain/app/app.js';
import type { CapabilitySecretRepository } from '@core/domain/ports/repositories.js';

class InMemoryCapabilitySecretRepository implements CapabilitySecretRepository {
  private readonly records = new Map<string, CapabilitySecret>();

  async getSecret(input: {
    appId: AppId;
    name: string;
  }): Promise<CapabilitySecret | null> {
    return this.records.get(`${input.appId}:${input.name}`) ?? null;
  }

  async listSecrets(input: {
    appId: AppId;
  }): Promise<CapabilitySecretMetadata[]> {
    return [...this.records.values()]
      .filter((record) => record.appId === input.appId)
      .map(({ value: _value, ...metadata }) => metadata);
  }

  async upsertSecret(input: {
    appId: AppId;
    name: string;
    value: string;
    allowedCapabilityIds?: string[];
    actor?: string;
    now?: string;
  }): Promise<CapabilitySecretMetadata> {
    const now = input.now ?? '2026-05-17T00:00:00.000Z';
    const id = `secret:${input.appId}:${input.name}` as never;
    const record: CapabilitySecret = {
      id,
      appId: input.appId,
      name: input.name,
      value: input.value,
      allowedCapabilityIds: input.allowedCapabilityIds ?? [],
      ...(input.actor
        ? { createdBy: input.actor, updatedBy: input.actor }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(`${input.appId}:${input.name}`, record);
    const { value: _value, ...metadata } = record;
    return metadata;
  }

  async deleteSecret(input: { appId: AppId; name: string }): Promise<boolean> {
    return this.records.delete(`${input.appId}:${input.name}`);
  }
}

describe('CapabilitySecretService', () => {
  it('normalizes names and resolves unrestricted secrets into env', async () => {
    const repository = new InMemoryCapabilitySecretRepository();
    const service = new CapabilitySecretService(repository);

    await service.set({
      appId: 'default' as AppId,
      name: 'github_token',
      value: 'token-value',
    });

    await expect(
      service.resolveEnv({
        appId: 'default' as AppId,
        names: ['GITHUB_TOKEN'],
      }),
    ).resolves.toEqual({
      env: { GITHUB_TOKEN: 'token-value' },
      missing: [],
    });
  });

  it('treats secrets outside their allow list as missing', async () => {
    const repository = new InMemoryCapabilitySecretRepository();
    const service = new CapabilitySecretService(repository);

    await service.set({
      appId: 'default' as AppId,
      name: 'GITHUB_TOKEN',
      value: 'token-value',
      allowedCapabilityIds: ['mcp:github'],
    });

    await expect(
      service.resolveEnv({
        appId: 'default' as AppId,
        names: ['GITHUB_TOKEN'],
        allowedCapabilityIds: ['mcp:linear'],
      }),
    ).resolves.toEqual({
      env: {},
      missing: ['GITHUB_TOKEN'],
    });

    await expect(
      service.resolveEnv({
        appId: 'default' as AppId,
        names: ['GITHUB_TOKEN'],
        allowedCapabilityIds: ['mcp:github'],
      }),
    ).resolves.toEqual({
      env: { GITHUB_TOKEN: 'token-value' },
      missing: [],
    });
  });

  it('resolves skill-scoped secrets for selected skill action env refs', async () => {
    const repository = new InMemoryCapabilitySecretRepository();
    const service = new CapabilitySecretService(repository);
    const appId = 'default' as AppId;

    await service.set({
      appId,
      name: 'PRIVATE_SKILL_TOKEN_REF',
      value: 'token-value',
      allowedCapabilityIds: ['skill:Private Skill'],
    });

    await expect(
      resolveSelectedSkillEnvForAgent({
        appId,
        agentId: 'agent:one' as never,
        secrets: repository,
        runtimeAccess: [
          {
            selectedCapabilityId: 'skill.private.publish',
            sourceType: 'skill_action',
            auditLabel: 'Private Skill publish',
            skillId: 'skill:private',
            selectedAction: 'publish',
            declaredEnvRefs: ['PRIVATE_SKILL_TOKEN_REF'],
            commandRules: ['RunCommand(skills/private-skill/post.py *)'],
          },
        ],
        skills: {
          listEnabledSkillsForAgent: async () => [
            {
              id: 'skill:private' as never,
              appId,
              name: 'Private Skill',
              requiredEnvVars: ['PRIVATE_SKILL_TOKEN_REF'],
            },
          ],
        } as never,
      }),
    ).resolves.toEqual({
      env: { PRIVATE_SKILL_TOKEN_REF: 'token-value' },
    });
  });

  it('does not project selected skill secrets without selected action authority', async () => {
    const repository = new InMemoryCapabilitySecretRepository();
    const service = new CapabilitySecretService(repository);
    const appId = 'default' as AppId;

    await service.set({
      appId,
      name: 'PRIVATE_SKILL_TOKEN_REF',
      value: 'token-value',
      allowedCapabilityIds: ['skill.private.publish'],
    });

    await expect(
      resolveSelectedSkillEnvForAgent({
        appId,
        agentId: 'agent:one' as never,
        secrets: repository,
        runtimeAccess: [],
        skills: {
          listEnabledSkillsForAgent: async () => [
            {
              id: 'skill:private' as never,
              appId,
              name: 'Private Skill',
              requiredEnvVars: ['PRIVATE_SKILL_TOKEN_REF'],
            },
          ],
        } as never,
      }),
    ).resolves.toEqual({
      env: {},
    });
  });
});
