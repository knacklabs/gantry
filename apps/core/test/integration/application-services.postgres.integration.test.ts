import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppMemoryService } from '@core/memory/app-memory-service.js';
import {
  DEFAULT_APP_ID,
  DEFAULT_LLM_PROFILE_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import type { AppId } from '@core/domain/app/app.js';
import type { AgentId } from '@core/domain/agent/agent.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const appId = DEFAULT_APP_ID as AppId;
const now = '2026-04-28T00:00:00.000Z';

maybeDescribe('application services with Postgres repositories', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'app_services',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('persists agent config, run events, memory, permission decisions, and sandbox leases across service boundaries', async () => {
    const agentId = 'agent:integration:1' as AgentId;
    await runtime.repositories.agents.saveAgent({
      id: agentId,
      appId,
      name: 'Integration Agent',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    const configVersionId = 'agent-config:integration:1' as never;
    await runtime.repositories.agentConfigs.saveConfigVersion({
      id: configVersionId,
      appId,
      agentId,
      version: 1,
      promptProfileRef: 'prompt-profile:default',
      llmProfileId: DEFAULT_LLM_PROFILE_ID as never,
      toolIds: ['tool:search' as never],
      skillIds: ['skill:approved' as never],
      permissionPolicyIds: ['permission-policy:review' as never],
      runtimeLimits: { timeoutMs: 30_000 },
      createdAt: now,
    });

    await runtime.repositories.agents.saveAgent({
      id: agentId,
      appId,
      name: 'Integration Agent',
      status: 'active',
      currentConfigVersionId: configVersionId,
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      runtime.repositories.agentConfigs.getConfigVersion(configVersionId),
    ).resolves.toMatchObject({
      id: configVersionId,
      permissionPolicyIds: ['permission-policy:review'],
      skillIds: ['skill:approved'],
    });

    await runtime.repositories.permissions.saveDecision({
      id: 'permission-decision:integration:allow' as never,
      appId,
      effect: 'allow',
      reason: 'Approved in integration test',
      actorContext: { channel: 'slack' },
      actionPreview: 'Run tool',
      approverRef: 'user:admin',
      createdAt: now,
    });
    await expect(
      runtime.repositories.permissions.getDecision(
        'permission-decision:integration:allow' as never,
      ),
    ).resolves.toMatchObject({
      effect: 'allow',
      approverRef: 'user:admin',
    });

    const memoryService = new AppMemoryService(runtime.service.db);
    await memoryService.save({
      appId,
      agentId,
      groupId: 'integration-service-boundary',
      kind: 'decision',
      key: 'integration-depth',
      value: 'Deep integration tests cover service boundaries.',
      source: 'test',
      confidence: 0.99,
    });
    await expect(
      memoryService.list({
        appId,
        agentId,
        groupId: 'integration-service-boundary',
        includeCommon: false,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        key: 'integration-depth',
        value: 'Deep integration tests cover service boundaries.',
      }),
    ]);

    const run = {
      id: 'agent-run:integration:1',
      appId,
      agentId,
      configVersionId,
      llmProfileId: DEFAULT_LLM_PROFILE_ID,
      executionProviderId: 'anthropic:claude-agent-sdk',
      permissionDecisionIds: ['permission-decision:integration:allow'],
      cause: 'manual',
      status: 'running',
      createdAt: now,
      startedAt: now,
    } as never;
    await runtime.repositories.agentRuns.saveAgentRun(run);
    await runtime.repositories.runtimeEvents.appendRuntimeEvent({
      appId,
      runId: 'agent-run:integration:1' as never,
      eventType: RUNTIME_EVENT_TYPES.RUN_STARTED,
      actor: 'runtime',
      payload: { status: 'running' },
      createdAt: now,
    });
    await expect(
      runtime.repositories.runtimeEvents.listRuntimeEvents({
        appId,
        runId: 'agent-run:integration:1' as never,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.RUN_STARTED,
        payload: { status: 'running' },
      }),
    ]);

    await runtime.repositories.sandboxes.saveSandboxProfile({
      id: 'sandbox-profile:integration' as never,
      appId,
      name: 'Integration sandbox',
      filesystem: { mode: 'read-only' },
      network: { mode: 'disabled' },
      process: { mode: 'restricted' },
      browser: { mode: 'disabled' },
      credentialAccess: { mode: 'none' },
      timeoutMs: 30_000,
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.sandboxes.saveSandboxLease({
      id: 'sandbox-lease:integration' as never,
      appId,
      profileId: 'sandbox-profile:integration' as never,
      runId: 'agent-run:integration:1' as never,
      permissionDecisionId: 'permission-decision:integration:allow' as never,
      status: 'active',
      grantedAt: now,
      expiresAt: '2026-04-28T00:30:00.000Z',
    });
    await expect(
      runtime.repositories.sandboxes.getSandboxLease(
        'sandbox-lease:integration' as never,
      ),
    ).resolves.toMatchObject({
      permissionDecisionId: 'permission-decision:integration:allow',
      runId: 'agent-run:integration:1',
    });
  });

  it('keeps one installed skill row per app and materialized skill name', async () => {
    const agentId = 'agent:skill-owner' as AgentId;
    await runtime.repositories.agents.saveAgent({
      id: agentId,
      appId,
      name: 'Skill Owner',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    const baseSkill = {
      appId,
      name: 'Shared Bundle',
      description: 'Same skill name in separate install origins',
      status: 'installed' as const,
      promptRefs: [],
      toolIds: [],
      workflowRefs: [],
      storage: {
        storageType: 'local-filesystem' as const,
        storageRef: 'skills/shared-bundle',
        contentHash: 'sha256:shared-skill-bundle',
        sizeBytes: 123,
      },
      createdAt: now,
      updatedAt: now,
    };

    await runtime.repositories.skills.saveSkill({
      ...baseSkill,
      id: 'skill:agent-owned-duplicate' as never,
      agentId,
      source: 'agent_created',
      createdBy: agentId,
    });

    await expect(
      runtime.repositories.skills.saveSkill({
        ...baseSkill,
        id: 'skill:admin-owned-duplicate' as never,
        source: 'admin_uploaded',
        createdBy: 'admin-user',
      }),
    ).rejects.toThrow();
  });

  it('keeps app memory writes isolated by agent and updates existing memory keys idempotently', async () => {
    const primaryAgentId = 'agent:memory-primary' as AgentId;
    const secondaryAgentId = 'agent:memory-secondary' as AgentId;
    await runtime.repositories.agents.saveAgent({
      id: primaryAgentId,
      appId,
      name: 'Primary Memory Agent',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.agents.saveAgent({
      id: secondaryAgentId,
      appId,
      name: 'Secondary Memory Agent',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    const memoryService = new AppMemoryService(runtime.service.db);
    const primaryFirst = await memoryService.save({
      appId,
      agentId: primaryAgentId,
      groupId: 'shared-memory-group',
      kind: 'fact',
      key: 'shared-key',
      value: 'primary value v1',
      source: 'integration-test',
      confidence: 0.7,
    });
    const secondaryFirst = await memoryService.save({
      appId,
      agentId: secondaryAgentId,
      groupId: 'shared-memory-group',
      kind: 'fact',
      key: 'shared-key',
      value: 'secondary value v1',
      source: 'integration-test',
      confidence: 0.8,
    });
    const primaryUpdated = await memoryService.save({
      appId,
      agentId: primaryAgentId,
      groupId: 'shared-memory-group',
      kind: 'fact',
      key: 'shared-key',
      value: 'primary value v2',
      source: 'integration-test',
      confidence: 0.9,
    });
    expect(primaryUpdated.id).toBe(primaryFirst.id);
    expect(primaryUpdated.version).toBe(2);
    expect(secondaryFirst.version).toBe(1);

    await expect(
      memoryService.list({
        appId,
        agentId: primaryAgentId,
        groupId: 'shared-memory-group',
        includeCommon: false,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: primaryFirst.id,
        key: 'shared-key',
        value: 'primary value v2',
        confidence: 0.9,
        version: 2,
      }),
    ]);
    await expect(
      memoryService.list({
        appId,
        agentId: secondaryAgentId,
        groupId: 'shared-memory-group',
        includeCommon: false,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: secondaryFirst.id,
        key: 'shared-key',
        value: 'secondary value v1',
        version: 1,
      }),
    ]);
  });
});
