import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentCreationDraft } from '@core/domain/agent-creation/agent-creation-draft.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

function draft(
  id: string,
  appId: string,
  updatedAt = '2026-08-14T00:00:00.000Z',
): AgentCreationDraft {
  return {
    id: id as AgentCreationDraft['id'],
    appId: appId as AgentCreationDraft['appId'],
    revision: 1,
    status: 'draft',
    currentStep: 'identity',
    document: { name: id },
    progress: {},
    createdAt: updatedAt as AgentCreationDraft['createdAt'],
    updatedAt: updatedAt as AgentCreationDraft['updatedAt'],
  };
}

maybeDescribe('PostgresAgentCreationDraftRepository integration', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'agent_creation_drafts',
    });
    await runtime.repositories.apps.saveApp({
      id: 'app:other' as never,
      slug: 'other',
      name: 'Other App',
      status: 'active',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime.cleanup();
  });

  it('isolates apps and fences saves, claims, deletion, and retention', async () => {
    const repository = runtime.repositories.agentCreationDrafts;
    const saved = await repository.saveDraft({
      draft: draft('draft:one', 'default'),
    });
    expect(saved).not.toBe('conflict');
    if (saved === 'conflict') throw new Error('draft insert conflicted');
    expect(saved.createdAt).toMatch(/T.*Z$/);
    expect(saved.updatedAt).toMatch(/T.*Z$/);

    await expect(
      repository.getDraft({
        appId: 'app:other' as never,
        id: saved.id,
      }),
    ).resolves.toBeNull();
    await expect(repository.listDrafts('app:other' as never)).resolves.toEqual(
      [],
    );

    const claimed = await repository.claimDraft({
      appId: saved.appId,
      id: saved.id,
      leaseToken: 'lease:one',
      leaseExpiresAt: '2026-08-14T00:10:00.000Z',
      now: '2026-08-14T00:01:00.000Z',
    });
    expect(claimed).toMatchObject({
      revision: 2,
      status: 'applying',
      leaseToken: 'lease:one',
    });
    expect(claimed?.leaseExpiresAt).toMatch(/T.*Z$/);
    await expect(
      repository.claimDraft({
        appId: saved.appId,
        id: saved.id,
        leaseToken: 'lease:two',
        leaseExpiresAt: '2026-08-14T00:11:00.000Z',
        now: '2026-08-14T00:02:00.000Z',
      }),
    ).resolves.toBeNull();
    const reclaimed = await repository.claimDraft({
      appId: saved.appId,
      id: saved.id,
      leaseToken: 'lease:two',
      leaseExpiresAt: '2026-08-14T00:21:00.000Z',
      now: '2026-08-14T00:20:00.000Z',
    });
    expect(reclaimed).toMatchObject({
      revision: 3,
      leaseToken: 'lease:two',
    });
    await expect(
      repository.saveDraft({
        draft: { ...saved, currentStep: 'model' },
        expectedRevision: saved.revision,
      }),
    ).resolves.toBe('conflict');

    const removable = await repository.saveDraft({
      draft: draft('draft:removable', 'default'),
    });
    expect(removable).not.toBe('conflict');
    if (removable === 'conflict') throw new Error('draft insert conflicted');
    await expect(
      repository.deleteDraft({
        appId: 'app:other' as never,
        id: removable.id,
      }),
    ).resolves.toBe('not_found');
    await expect(
      repository.deleteDraft({ appId: removable.appId, id: removable.id }),
    ).resolves.toBe('deleted');

    await runtime.repositories.agents.saveAgent({
      id: 'agent:draft-receipt' as never,
      appId: 'default' as never,
      name: 'Created Agent',
      status: 'active',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    });
    const receipt = await repository.saveDraft({
      draft: {
        ...draft('draft:receipt', 'default'),
        status: 'completed',
        agentId: 'agent:draft-receipt' as never,
        completedAt: '2026-08-14T00:03:00.000Z' as never,
      },
    });
    expect(receipt).not.toBe('conflict');
    if (receipt === 'conflict') throw new Error('draft insert conflicted');
    const futureReceipt = await repository.saveDraft({
      draft: {
        ...draft('draft:future-receipt', 'default'),
        status: 'completed',
        agentId: 'agent:draft-receipt' as never,
        completedAt: '2026-08-14T00:05:00.000Z' as never,
      },
    });
    expect(futureReceipt).not.toBe('conflict');
    if (futureReceipt === 'conflict')
      throw new Error('draft insert conflicted');
    await expect(
      repository.deleteDraft({ appId: receipt.appId, id: receipt.id }),
    ).resolves.toBe('agent_exists');
    await expect(
      repository.claimDraft({
        appId: receipt.appId,
        id: receipt.id,
        leaseToken: 'lease:receipt',
        leaseExpiresAt: '2026-08-14T00:11:00.000Z',
        now: '2026-08-14T00:10:00.000Z',
      }),
    ).resolves.toBeNull();
    await expect(
      repository.deleteCompletedBefore({
        before: '2026-08-14T00:04:00.000Z',
        limit: 1,
      }),
    ).resolves.toBe(1);
    await expect(
      repository.getDraft({ appId: receipt.appId, id: receipt.id }),
    ).resolves.toBeNull();
    await expect(
      repository.getDraft({
        appId: futureReceipt.appId,
        id: futureReceipt.id,
      }),
    ).resolves.not.toBeNull();
  });
});
