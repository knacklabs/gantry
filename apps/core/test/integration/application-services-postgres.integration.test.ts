import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CreateAgentUseCase } from '@core/application/agents/create-agent-use-case.js';
import { PublishAgentConfigVersionUseCase } from '@core/application/agents/publish-agent-config-version-use-case.js';
import { ResolveEffectiveAgentConfigService } from '@core/application/agents/resolve-effective-agent-config-service.js';
import { UpdateAgentConfigUseCase } from '@core/application/agents/update-agent-config-use-case.js';
import { SaveMemoryUseCase } from '@core/application/memory/save-memory-use-case.js';
import { RecordPermissionDecisionUseCase } from '@core/application/permissions/record-permission-decision-use-case.js';
import { StartAgentRunUseCase } from '@core/application/runs/start-agent-run-use-case.js';
import { CreateSandboxLeaseUseCase } from '@core/application/sandbox/create-sandbox-lease-use-case.js';
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
  let idCounter = 0;
  const ids = { generate: () => `integration-id:${++idCounter}` };
  const clock = { now: () => now };

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'app_services',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('persists agent config, run events, memory, permission decisions, and sandbox leases across service boundaries', async () => {
    const created = await new CreateAgentUseCase({
      agents: runtime.repositories.agents,
      ids,
      clock,
    }).execute({
      appId,
      name: 'Integration Agent',
    });
    const agentId = created.agent.id as AgentId;

    const published = await new PublishAgentConfigVersionUseCase({
      configs: runtime.repositories.agentConfigs,
      ids,
    }).execute({
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

    await new UpdateAgentConfigUseCase({
      agents: runtime.repositories.agents,
      clock,
    }).execute({
      agentId,
      currentConfigVersionId: published.version.id,
    });
    await expect(
      new ResolveEffectiveAgentConfigService({
        agents: runtime.repositories.agents,
        configs: runtime.repositories.agentConfigs,
      }).resolve({ agentId }),
    ).resolves.toMatchObject({
      config: {
        id: published.version.id,
        permissionPolicyIds: ['permission-policy:review'],
        skillIds: ['skill:approved'],
      },
    });

    await new RecordPermissionDecisionUseCase(
      runtime.repositories.permissions,
    ).execute({
      decision: {
        id: 'permission-decision:integration:allow' as never,
        appId,
        effect: 'allow',
        reason: 'Approved in integration test',
        actorContext: { channel: 'slack' },
        actionPreview: 'Run tool',
        approverRef: 'user:admin',
        createdAt: now,
      },
    });
    await expect(
      runtime.repositories.permissions.getDecision(
        'permission-decision:integration:allow' as never,
      ),
    ).resolves.toMatchObject({
      effect: 'allow',
      approverRef: 'user:admin',
    });

    await new SaveMemoryUseCase(runtime.repositories.memory).execute({
      item: {
        id: 'memory:integration:agent' as never,
        appId,
        agentId,
        subject: { kind: 'agent', appId, agentId },
        kind: 'decision',
        key: 'integration-depth',
        value: 'Deep integration tests cover service boundaries.',
        source: 'test',
        confidence: 0.99,
        isPinned: true,
        isDeleted: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    await expect(
      runtime.repositories.memory.listMemoryItems({
        kind: 'agent',
        appId,
        agentId,
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
      configVersionId: published.version.id,
      llmProfileId: DEFAULT_LLM_PROFILE_ID,
      permissionDecisionIds: ['permission-decision:integration:allow'],
      cause: 'manual',
      status: 'running',
      createdAt: now,
      startedAt: now,
    } as never;
    await new StartAgentRunUseCase(runtime.repositories.agentRuns).execute({
      run,
    });
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
    const sandboxProvider = {
      acquireLease: async () => ({
        id: 'sandbox-lease:integration' as never,
        appId,
        profileId: 'sandbox-profile:integration' as never,
        runId: 'agent-run:integration:1' as never,
        permissionDecisionId: 'permission-decision:integration:allow' as never,
        status: 'active',
        grantedAt: now,
        expiresAt: '2026-04-28T00:30:00.000Z',
      }),
    };
    await new CreateSandboxLeaseUseCase({
      provider: sandboxProvider as never,
      sandboxes: runtime.repositories.sandboxes,
    }).execute({
      profile: { id: 'sandbox-profile:integration' } as never,
      run,
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

  it('allows identical skill content in separate admin and agent ownership scopes', async () => {
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
      description: 'Same bundle in separate owner scopes',
      version: 'same-hash',
      status: 'draft' as const,
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
    await runtime.repositories.skills.saveSkill({
      ...baseSkill,
      id: 'skill:admin-owned-duplicate' as never,
      source: 'admin_uploaded',
      createdBy: 'admin-user',
    });

    await expect(
      runtime.repositories.skills.getSkillByContentHash?.({
        appId,
        agentId,
        contentHash: 'sha256:shared-skill-bundle',
        statuses: ['draft'],
      }),
    ).resolves.toMatchObject({
      id: 'skill:agent-owned-duplicate',
      agentId,
    });
    await expect(
      runtime.repositories.skills.getSkillByContentHash?.({
        appId,
        agentId: null,
        contentHash: 'sha256:shared-skill-bundle',
        statuses: ['draft'],
      }),
    ).resolves.toMatchObject({
      id: 'skill:admin-owned-duplicate',
      agentId: undefined,
    });
  });

  it('keeps memory writes isolated by agent and updates existing memory ids idempotently', async () => {
    const createAgent = new CreateAgentUseCase({
      agents: runtime.repositories.agents,
      ids,
      clock,
    });
    const primary = await createAgent.execute({
      appId,
      name: 'Primary Memory Agent',
    });
    const secondary = await createAgent.execute({
      appId,
      name: 'Secondary Memory Agent',
    });

    const saveMemory = new SaveMemoryUseCase(runtime.repositories.memory);
    await saveMemory.execute({
      item: {
        id: 'memory:integration:isolation:primary' as never,
        appId,
        agentId: primary.agent.id as AgentId,
        subject: {
          kind: 'agent',
          appId,
          agentId: primary.agent.id as AgentId,
        },
        kind: 'fact',
        key: 'shared-key',
        value: 'primary value v1',
        source: 'integration-test',
        confidence: 0.7,
        isPinned: false,
        isDeleted: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    await saveMemory.execute({
      item: {
        id: 'memory:integration:isolation:secondary' as never,
        appId,
        agentId: secondary.agent.id as AgentId,
        subject: {
          kind: 'agent',
          appId,
          agentId: secondary.agent.id as AgentId,
        },
        kind: 'fact',
        key: 'shared-key',
        value: 'secondary value v1',
        source: 'integration-test',
        confidence: 0.8,
        isPinned: false,
        isDeleted: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    await saveMemory.execute({
      item: {
        id: 'memory:integration:isolation:primary' as never,
        appId,
        agentId: primary.agent.id as AgentId,
        subject: {
          kind: 'agent',
          appId,
          agentId: primary.agent.id as AgentId,
        },
        kind: 'fact',
        key: 'shared-key',
        value: 'primary value v2',
        source: 'integration-test',
        confidence: 0.9,
        isPinned: true,
        isDeleted: false,
        createdAt: now,
        updatedAt: '2026-04-28T00:05:00.000Z',
      },
    });

    await expect(
      runtime.repositories.memory.listMemoryItems({
        kind: 'agent',
        appId,
        agentId: primary.agent.id as AgentId,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'memory:integration:isolation:primary',
        key: 'shared-key',
        value: 'primary value v2',
        isPinned: true,
      }),
    ]);
    await expect(
      runtime.repositories.memory.listMemoryItems({
        kind: 'agent',
        appId,
        agentId: secondary.agent.id as AgentId,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'memory:integration:isolation:secondary',
        key: 'shared-key',
        value: 'secondary value v1',
      }),
    ]);
  });
});
