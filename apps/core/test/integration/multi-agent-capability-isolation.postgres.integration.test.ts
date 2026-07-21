import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SettingsDesiredStateService } from '@core/config/settings/desired-state-service.js';
import {
  createDefaultRuntimeSettings,
  ensureConfiguredAgent,
} from '@core/config/settings/runtime-settings.js';
import type { AgentId } from '@core/domain/agent/agent.js';
import type { AppId } from '@core/domain/app/app.js';
import { resolveConfiguredToolPolicy } from '@core/runtime/configured-agent-tools.js';
import {
  semanticCapabilityInputSchema,
  type SemanticCapabilityDefinition,
} from '@core/shared/semantic-capabilities.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const APP_ID = 'default' as AppId;
const AGENT_A_FOLDER = 'capability_agent_a';
const AGENT_B_FOLDER = 'capability_agent_b';
const AGENT_A_ID = `agent:${AGENT_A_FOLDER}` as AgentId;
const AGENT_B_ID = `agent:${AGENT_B_FOLDER}` as AgentId;

// Reuses the desired-state-to-policy projection seam from
// capability-lifecycle.postgres.integration.test.ts.
maybeDescribe('multi-agent capability isolation (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'multi_agent_capability_isolation',
    });
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.cleanup();
  });

  it('keeps a desired-state capability grant scoped to one co-resident agent', async () => {
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
    await runtime.repositories.tools.saveTool({
      id: `tool:capability:${capability.capabilityId}` as never,
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
      agentId: AGENT_A_FOLDER,
      agentName: 'Capability Agent A',
      agentFolder: AGENT_A_FOLDER,
    });
    ensureConfiguredAgent(settings, {
      agentId: AGENT_B_FOLDER,
      agentName: 'Capability Agent B',
      agentFolder: AGENT_B_FOLDER,
    });
    settings.agents[AGENT_A_FOLDER]!.capabilities = [
      { id: capability.capabilityId, version: '1' },
    ];

    const reconciled = await new SettingsDesiredStateService({
      ops: runtime.ops,
      repositories: runtime.repositories,
      clock: { now: () => now },
    }).reconcile(settings);
    expect(reconciled.invalidReferences).toEqual([]);

    const project = (agentId: AgentId) =>
      resolveConfiguredToolPolicy({
        repository: runtime.repositories.tools,
        appId: APP_ID,
        agentId,
      });
    const [agentAPolicy, agentBPolicy] = await Promise.all([
      project(AGENT_A_ID),
      project(AGENT_B_ID),
    ]);
    const grantedRules = [
      `capability:${capability.capabilityId}`,
      'RunCommand(/opt/acme/bin/acme records append *)',
    ];

    expect(agentAPolicy.toolPolicyRules).toEqual(grantedRules);
    expect(agentBPolicy.toolPolicyRules).toEqual([]);
    expect(agentAPolicy.runtimeAccess).toEqual([
      expect.objectContaining({
        selectedCapabilityId: capability.capabilityId,
        sourceType: 'builtin_tool',
        runtimeToolRules: ['RunCommand(/opt/acme/bin/acme records append *)'],
      }),
    ]);
    expect(agentBPolicy.runtimeAccess).toEqual([]);
  });
});
