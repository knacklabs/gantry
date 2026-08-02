import { describe, expect, it } from 'vitest';

import { CapabilitySecretService } from '@core/application/capability-secrets/capability-secret-service.js';
import { resolveMcpCredentialEnvForAgent } from '@core/application/capability-secrets/mcp-secret-projection.js';
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

  it('fails closed when snapshot MCP credentials belong to another app', async () => {
    const repository = new InMemoryCapabilitySecretRepository();

    await expect(
      resolveMcpCredentialEnvForAgent({
        appId: 'default' as never,
        agentId: 'agent:test' as never,
        mcpServers: {} as never,
        secrets: repository,
        accessSnapshot: {
          appId: 'default',
          agentId: 'agent:test',
          tools: { activeBindings: [], appActiveDefinitions: [] },
          skills: { activeBindings: [], enabledDefinitions: [] },
          mcp: {
            activeBindings: [],
            materializedServers: [
              {
                definition: {
                  id: 'mcp:github',
                  appId: 'app:other',
                  name: 'github',
                  status: 'active',
                  transport: 'http',
                  config: {
                    transport: 'http',
                    url: 'https://mcp.example.test/github',
                  },
                  allowedToolPatterns: [],
                  autoApproveToolPatterns: [],
                  credentialRefs: [
                    {
                      name: 'GITHUB_TOKEN',
                      target: 'env',
                      key: 'GITHUB_TOKEN',
                    },
                  ],
                  networkHosts: [],
                  createdSource: 'admin',
                  riskClass: 'medium',
                  createdAt: '2026-06-02T00:00:00.000Z',
                  updatedAt: '2026-06-02T00:00:00.000Z',
                },
                binding: {
                  id: 'binding:github',
                  appId: 'default',
                  agentId: 'agent:test',
                  serverId: 'mcp:github',
                  status: 'active',
                  required: false,
                  permissionPolicyIds: [],
                  allowedToolPatterns: [],
                  createdAt: '2026-06-02T00:00:00.000Z',
                  updatedAt: '2026-06-02T00:00:00.000Z',
                },
              },
            ],
          },
        },
      }),
    ).rejects.toThrow(
      'MCP credential projection MCP materialized snapshot row owner mismatch.',
    );
  });

  it('does not flatten credentials from an unselected route into selected MCP servers', async () => {
    const repository = new InMemoryCapabilitySecretRepository();
    await repository.upsertSecret({
      appId: 'default' as never,
      name: 'SHARED_TOKEN',
      value: 'out-of-route-value',
      allowedCapabilityIds: ['mcp:outside'],
    });

    await expect(
      resolveMcpCredentialEnvForAgent({
        appId: 'default' as never,
        agentId: 'agent:test' as never,
        serverIds: ['mcp:inside' as never],
        mcpServers: {} as never,
        secrets: repository,
        accessSnapshot: {
          appId: 'default',
          agentId: 'agent:test',
          tools: { activeBindings: [], appActiveDefinitions: [] },
          skills: { activeBindings: [], enabledDefinitions: [] },
          mcp: {
            activeBindings: [],
            materializedServers: [
              mcpCredentialRecord('outside', 'conversation:outside'),
              mcpCredentialRecord('inside', 'conversation:inside'),
            ],
          },
        },
      }),
    ).resolves.toEqual({});
  });
});

function mcpCredentialRecord(name: string, conversationId: string) {
  const timestamp = '2026-08-02T00:00:00.000Z';
  return {
    definition: {
      id: `mcp:${name}`,
      appId: 'default',
      name,
      status: 'active',
      transport: 'http',
      config: { transport: 'http', url: `https://${name}.example.test/mcp` },
      allowedToolPatterns: ['read_*'],
      autoApproveToolPatterns: [],
      credentialRefs: [{ name: 'SHARED_TOKEN', target: 'env', key: 'TOKEN' }],
      networkHosts: [],
      createdSource: 'admin',
      riskClass: 'low',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    binding: {
      id: `binding:${name}`,
      appId: 'default',
      agentId: 'agent:test',
      serverId: `mcp:${name}`,
      status: 'active',
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: [],
      conversationId,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  } as never;
}
