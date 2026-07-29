import { inspect } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PostgresCapabilitySecretRepository } from '@core/adapters/storage/postgres/repositories/capability-secret-repository.postgres.js';
import {
  CredentialSecretCryptoIntegrityError,
  SECRET_ENCRYPTION_KEY_ENV,
} from '@core/adapters/storage/postgres/repositories/credential-secret-crypto.js';
import { CapabilitySecretService } from '@core/application/capability-secrets/capability-secret-service.js';
import { resolveMcpCredentialEnvForAgent } from '@core/application/capability-secrets/mcp-secret-projection.js';
import { McpServerService } from '@core/application/mcp/mcp-server-service.js';
import { SettingsDesiredStateService } from '@core/config/settings/desired-state-service.js';
import {
  createDefaultRuntimeSettings,
  ensureConfiguredAgent,
} from '@core/config/settings/runtime-settings.js';
import type { AgentId } from '@core/domain/agent/agent.js';
import type { AppId } from '@core/domain/app/app.js';
import type { RuntimeSecretProvider } from '@core/domain/ports/runtime-secret-provider.js';
import { logger } from '@core/infrastructure/logging/logger.js';
import { resolveConfiguredToolPolicy } from '@core/runtime/configured-agent-tools.js';
import {
  semanticCapabilityInputSchema,
  type SemanticCapabilityDefinition,
} from '@core/shared/semantic-capabilities.js';
import {
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '@core/shared/tool-execution-policy-service.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const APP_ID = 'default' as AppId;
const ADMISSION_AGENT_FOLDER = 'capability_admission';
const ADMISSION_AGENT_ID = `agent:${ADMISSION_AGENT_FOLDER}` as AgentId;
const SECRET_AGENT_ID = 'agent:capability_secret_chain' as AgentId;
const ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64');

const runtimeSecrets: RuntimeSecretProvider = {
  getSecret(ref) {
    const value = this.getOptionalSecret(ref);
    if (!value) throw new Error(`Missing ${ref.env}`);
    return value;
  },
  getOptionalSecret(ref) {
    return ref.env === SECRET_ENCRYPTION_KEY_ENV ? ENCRYPTION_KEY : undefined;
  },
};

// Matrix section 7 composes, rather than duplicates, the unit seams in
// configured-agent-tools.test.ts, semantic-capabilities.test.ts, and the two
// capability-secret suites. The shared Postgres harness is the same boundary
// used by fleet-capability-state-repositories.postgres.integration.test.ts;
// egress-gateway.test.ts remains the focused proof for network attribution.
maybeDescribe('capability lifecycle chains (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'capability_lifecycle',
    });
    const now = new Date().toISOString();
    await runtime.repositories.agents.saveAgent({
      id: SECRET_AGENT_ID,
      appId: APP_ID,
      name: 'Capability Secret Chain',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.cleanup();
  });

  it('persists a desired-state capability binding, projects its scoped rule, and admits only matching execution', async () => {
    const now = '2026-07-21T00:00:00.000Z';
    const capability: SemanticCapabilityDefinition = {
      capabilityId: 'acme.records.append',
      displayName: 'Acme records append',
      category: 'Acme',
      risk: 'write',
      can: 'Append reviewed records through configured access.',
      cannot: 'Read unrelated records or receive raw credentials.',
      credentialSource: 'configured_access',
      implementationBindings: [
        {
          kind: 'tool_rule',
          rule: 'RunCommand(/opt/acme/bin/acme records append *)',
        },
      ],
      preflight: { kind: 'none' },
    };
    const catalogToolId = `tool:capability:${capability.capabilityId}`;
    await runtime.repositories.tools.saveTool({
      id: catalogToolId as never,
      appId: APP_ID,
      name: `capability:${capability.capabilityId}`,
      kind: 'host',
      provider: 'gantry',
      displayName: capability.displayName,
      category: 'productivity',
      risk: 'high',
      selectable: true,
      status: 'active',
      adapterRef: `capability/${capability.capabilityId}`,
      inputSchema: semanticCapabilityInputSchema(capability),
      createdAt: now,
      updatedAt: now,
    });

    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    ensureConfiguredAgent(settings, {
      agentId: ADMISSION_AGENT_FOLDER,
      agentName: 'Capability Admission',
      agentFolder: ADMISSION_AGENT_FOLDER,
    });
    settings.agents[ADMISSION_AGENT_FOLDER]!.capabilities = [
      { id: capability.capabilityId, version: '1' },
    ];

    const reconciled = await new SettingsDesiredStateService({
      ops: runtime.ops,
      repositories: runtime.repositories,
      clock: { now: () => now },
    }).reconcile(settings);
    expect(reconciled.invalidReferences).toEqual([]);
    expect(reconciled.applied).toContain(
      `capabilities:${ADMISSION_AGENT_FOLDER}`,
    );
    await expect(
      runtime.repositories.tools.listAgentToolBindings({
        appId: APP_ID,
        agentId: ADMISSION_AGENT_ID,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolId: catalogToolId,
          status: 'active',
        }),
      ]),
    );

    const projected = await resolveConfiguredToolPolicy({
      repository: runtime.repositories.tools,
      appId: APP_ID,
      agentId: ADMISSION_AGENT_ID,
    });
    expect(projected.toolPolicyRules).toEqual(
      expect.arrayContaining([
        `capability:${capability.capabilityId}`,
        'RunCommand(/opt/acme/bin/acme records append *)',
      ]),
    );
    expect(projected.runtimeAccess).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          selectedCapabilityId: capability.capabilityId,
          sourceType: 'builtin_tool',
          runtimeToolRules: ['RunCommand(/opt/acme/bin/acme records append *)'],
        }),
      ]),
    );

    const classifier = new ToolExecutionClassifier();
    const policy = new ToolExecutionPolicyService();
    const evaluate = (command: string) =>
      policy.evaluate({
        request: classifier.classify({
          origin: 'sdk',
          toolName: 'Bash',
          toolInput: { command },
          executionMode: 'autonomous',
        }),
        autonomousAllowedToolRules: projected.toolPolicyRules ?? [],
      });

    expect(
      evaluate('/opt/acme/bin/acme records append --id record-1'),
    ).toMatchObject({
      status: 'allow',
      matchedRule: 'RunCommand(/opt/acme/bin/acme records append *)',
    });
    expect(
      evaluate('/opt/acme/bin/acme records delete --id record-1'),
    ).toMatchObject({ status: 'deny' });
  });

  it('stores, retrieves, rotates, and audits one capability secret lifecycle', async () => {
    const name = 'CAPABILITY_LIFECYCLE_TOKEN';
    const firstValue = 'capability-lifecycle-plaintext-v1';
    const rotatedValue = 'capability-lifecycle-plaintext-v2';
    const repository = new PostgresCapabilitySecretRepository(
      runtime.service.db,
      runtimeSecrets,
    );
    const service = new CapabilitySecretService(repository, (event) =>
      runtime.storageRuntime.runtimeEvents.publish(event),
    );

    await service.set({
      appId: APP_ID,
      name,
      value: firstValue,
      actor: 'integration:store',
      allowedCapabilityIds: ['acme.records.append'],
    });
    const stored = await runtime.service.pool.query<{
      id: string;
      value_encrypted: string;
      created_by: string;
      updated_by: string;
    }>(
      'select id, value_encrypted, created_by, updated_by from capability_secrets where app_id = $1 and name = $2',
      [APP_ID, name],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      id: `capability-secret:${APP_ID}:${name}`,
      created_by: 'integration:store',
      updated_by: 'integration:store',
    });
    const firstCiphertext = stored.rows[0]!.value_encrypted;
    expect(firstCiphertext).toMatch(/^gcred:v2:/);
    expect(firstCiphertext).not.toContain(firstValue);
    await expect(
      service.resolveEnv({
        appId: APP_ID,
        names: [name],
        allowedCapabilityIds: ['acme.records.append'],
      }),
    ).resolves.toEqual({
      env: { [name]: firstValue },
      missing: [],
    });

    await service.set({
      appId: APP_ID,
      name,
      value: rotatedValue,
      actor: 'integration:rotate',
      allowedCapabilityIds: ['acme.records.append'],
    });
    const rotated = await runtime.service.pool.query<{
      value_encrypted: string;
      created_by: string;
      updated_by: string;
    }>(
      'select value_encrypted, created_by, updated_by from capability_secrets where app_id = $1 and name = $2',
      [APP_ID, name],
    );
    expect(rotated.rows).toHaveLength(1);
    expect(rotated.rows[0]).toMatchObject({
      created_by: 'integration:store',
      updated_by: 'integration:rotate',
    });
    expect(rotated.rows[0]!.value_encrypted).toMatch(/^gcred:v2:/);
    expect(rotated.rows[0]!.value_encrypted).not.toBe(firstCiphertext);
    expect(rotated.rows[0]!.value_encrypted).not.toContain(rotatedValue);
    const superseded = await runtime.service.pool.query<{ count: string }>(
      'select count(*) from capability_secrets where app_id = $1 and name = $2 and value_encrypted = $3',
      [APP_ID, name, firstCiphertext],
    );
    expect(Number(superseded.rows[0]!.count)).toBe(0);
    await expect(
      service.resolveEnv({
        appId: APP_ID,
        names: [name],
        allowedCapabilityIds: ['acme.records.append'],
      }),
    ).resolves.toEqual({
      env: { [name]: rotatedValue },
      missing: [],
    });

    const auditEvents = (
      await runtime.repositories.runtimeEvents.listRuntimeEvents({
        appId: APP_ID,
      })
    ).filter(
      (event) =>
        event.eventType === 'credential.capability.updated' &&
        (event.payload as { name?: string }).name === name,
    );
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents.map((event) => event.actor).sort()).toEqual([
      'integration:rotate',
      'integration:store',
    ]);
    expect(inspect(auditEvents, { depth: 10 })).not.toContain(firstValue);
    expect(inspect(auditEvents, { depth: 10 })).not.toContain(rotatedValue);
  });

  it('treats tampered ciphertext as an integrity failure and leaves the sandbox capability unavailable without leaking plaintext', async () => {
    const name = 'TAMPERED_MCP_TOKEN';
    const plaintextMarker = 'seeded-tamper-plaintext-marker';
    const mcpName = 'tampered_capability';
    const secretRepository = new PostgresCapabilitySecretRepository(
      runtime.service.db,
      runtimeSecrets,
    );
    const secretService = new CapabilitySecretService(
      secretRepository,
      (event) => runtime.storageRuntime.runtimeEvents.publish(event),
    );
    const mcpService = new McpServerService(
      runtime.repositories.mcpServers,
      runtime.repositories.agents,
      {
        lookupHostname: async () => [{ family: 4, address: '93.184.216.34' }],
      },
    );
    const server = await mcpService.connectServer({
      appId: APP_ID,
      name: mcpName,
      transportConfig: {
        transport: 'http',
        url: 'https://example.com/mcp',
      },
      allowedToolPatterns: ['read_records'],
      credentialRefs: [{ name, target: 'header', key: 'Authorization' }],
      createdBy: 'integration:tamper',
    });
    await mcpService.bindToAgent({
      appId: APP_ID,
      agentId: SECRET_AGENT_ID,
      serverId: server.id,
      required: true,
    });
    await secretService.set({
      appId: APP_ID,
      name,
      value: plaintextMarker,
      actor: 'integration:tamper',
      allowedCapabilityIds: [server.id, `mcp:${mcpName}`],
    });

    const stored = await runtime.service.pool.query<{
      value_encrypted: string;
    }>(
      'select value_encrypted from capability_secrets where app_id = $1 and name = $2',
      [APP_ID, name],
    );
    const ciphertext = stored.rows[0]!.value_encrypted;
    const replacement = ciphertext.endsWith('A') ? 'B' : 'A';
    const tampered = `${ciphertext.slice(0, -1)}${replacement}`;
    await runtime.service.pool.query(
      'update capability_secrets set value_encrypted = $3 where app_id = $1 and name = $2',
      [APP_ID, name, tampered],
    );

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const credentialEnv = await resolveMcpCredentialEnvForAgent({
        appId: APP_ID,
        agentId: SECRET_AGENT_ID,
        serverIds: [server.id],
        mcpServers: runtime.repositories.mcpServers,
        secrets: secretRepository,
      });
      expect(credentialEnv).toEqual({});
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy.mock.calls[0]?.[0]).toMatchObject({
        appId: APP_ID,
        name,
        err: expect.any(CredentialSecretCryptoIntegrityError),
      });

      const materialized = await mcpService.materializeForAgent({
        appId: APP_ID,
        agentId: SECRET_AGENT_ID,
        serverIds: [server.id],
        credentialEnv,
      });
      expect(materialized).toEqual([]);
      const mcpAudit = await runtime.repositories.mcpServers.listAuditEvents({
        appId: APP_ID,
        serverId: server.id,
      });
      expect(mcpAudit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: 'startup_failure',
            metadata: {
              name: mcpName,
              required: true,
            },
          }),
        ]),
      );
      const runtimeEvents =
        await runtime.repositories.runtimeEvents.listRuntimeEvents({
          appId: APP_ID,
        });
      const observableEvidence = inspect(
        {
          error: errorSpy.mock.calls,
          mcpAudit,
          runtimeEvents,
          materialized,
        },
        { depth: 20 },
      );
      expect(observableEvidence).not.toContain(plaintextMarker);
      expect(tampered).not.toContain(plaintextMarker);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
