import { describe, expect, it } from 'vitest';

import { AgentCreationService } from '@core/application/agent-creation/agent-creation-service.js';
import type { Agent } from '@core/domain/agent/agent.js';
import type { AgentCreationDraft } from '@core/domain/agent-creation/agent-creation-draft.js';

const appId = 'app:test' as never;
const now = '2026-08-14T00:00:00.000Z';

function draft(changes: Partial<AgentCreationDraft> = {}): AgentCreationDraft {
  return {
    id: 'agent-creation-draft:1' as never,
    appId,
    revision: 1,
    status: 'draft',
    currentStep: 'review',
    document: { name: 'Support agent', agentHarness: 'auto' },
    progress: {},
    createdAt: now,
    updatedAt: now,
    ...changes,
  };
}

function service(seed = draft(), existingAgents: Agent[] = []) {
  let saved = seed;
  const savedAgents = [...existingAgents];
  const harnesses: unknown[] = [];
  const drafts = {
    getDraft: async () => saved,
    saveDraft: async ({ draft: next }: { draft: AgentCreationDraft }) => {
      saved = { ...next, revision: next.revision + 1 };
      return saved;
    },
    claimDraft: async () => saved,
  };
  return {
    sut: new AgentCreationService({
      drafts: drafts as never,
      agents: {
        listAgents: async () => savedAgents,
        saveAgent: async (agent: Agent) => savedAgents.push(agent),
      } as never,
      agentSettings: {
        writeAgentHarnessSetting: async (input) => harnesses.push(input),
      } as never,
      runtimeHome: '/tmp/gantry',
      now: () => now,
    }),
    agents: savedAgents,
    harnesses,
    current: () => saved,
  };
}

describe('AgentCreationService', () => {
  it('blocks a duplicate name before claiming the durable draft', async () => {
    const existing: Agent = {
      id: 'agent:existing' as never,
      appId,
      name: 'support AGENT',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    const { sut } = service(draft(), [existing]);

    await expect(
      sut.createOrResume({
        appId,
        id: 'agent-creation-draft:1' as never,
        leaseToken: 'lease',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('does not report selected work configuration as complete before it is applied', async () => {
    const { sut } = service(
      draft({
        document: {
          name: 'Support agent',
          agentHarness: 'auto',
          delegateIds: ['agent:research'],
        },
      }),
    );

    await expect(
      sut.createOrResume({
        appId,
        id: 'agent-creation-draft:1' as never,
        leaseToken: 'lease',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('creates a stable agent once and records a completed receipt', async () => {
    const { sut, agents, harnesses, current } = service();

    const result = await sut.createOrResume({
      appId,
      id: 'agent-creation-draft:1' as never,
      leaseToken: 'lease',
    });

    expect(result.status).toBe('completed');
    expect(result.agentId).toMatch(/^agent:/);
    expect(agents).toHaveLength(1);
    expect(harnesses).toHaveLength(1);
    await sut.createOrResume({
      appId,
      id: 'agent-creation-draft:1' as never,
      leaseToken: 'lease-2',
    });
    expect(agents).toHaveLength(1);
    expect(current().agentId).toBe(result.agentId);
  });
});
