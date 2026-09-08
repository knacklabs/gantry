import { describe, expect, it, vi } from 'vitest';

import { offboardAgent } from '../../../../src/application/agents/offboard-agent.js';

describe('offboardAgent', () => {
  it('delegates the complete lifecycle command to the atomic repository', async () => {
    const repository = {
      offboard: vi.fn(async () => ({
        status: 'offboarded' as const,
        agentName: 'Support triage',
        providerAccountsDisabled: 1,
        conversationInstallsRemoved: 2,
        jobsCancelled: 3,
        settingsRevision: 4,
      })),
    };

    await expect(
      offboardAgent({
        repository,
        appId: 'app:one',
        agentId: 'agent:support' as never,
        defaultAgentId: 'agent:main' as never,
        expectedSettingsRevision: 3,
        settingsDocument: { agents: {} },
        createdBy: 'cli:agent-offboard',
        actor: { kind: 'system', source: 'cli:agent-offboard' },
        now: '2026-09-08T00:00:00.000Z',
        minReaderVersion: 1,
      }),
    ).resolves.toMatchObject({ status: 'offboarded', settingsRevision: 4 });

    expect(repository.offboard).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:support',
        actor: { kind: 'system', source: 'cli:agent-offboard' },
      }),
    );
  });
});
