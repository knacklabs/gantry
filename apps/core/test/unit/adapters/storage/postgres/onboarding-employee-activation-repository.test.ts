import { expect, it, vi } from 'vitest';

import { OnboardingEmployeeActivationRepository } from '@core/adapters/storage/postgres/repositories/onboarding/onboarding-employee-activation-repository.postgres.js';

it('replays an activated candidate after a post-commit projection failure', async () => {
  const limit = vi.fn(async () => [{ name: 'Atlas' }]);
  const tx = {
    execute: vi.fn(),
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })),
    })),
  };
  const db = {
    transaction: vi.fn(async (run) => run(tx)),
  };
  const candidates = {
    getModelCredentialCandidate: vi.fn(async () => ({
      id: 'candidate:atlas',
      providerId: 'anthropic',
      authMode: 'api_key',
      modelAlias: 'Sonnet 4.6',
      routeId: 'anthropic',
      state: 'activated',
      verificationExpiresAt: '2000-01-01T00:00:00.000Z',
    })),
  };
  const deployments = {
    ensureDeploymentWith: vi.fn(async () => ({
      agentId: 'agent:atlas',
      version: 1,
      desiredStateRevision: 2,
    })),
  };
  const repository = new OnboardingEmployeeActivationRepository(
    db as never,
    candidates as never,
    deployments as never,
  );

  await expect(
    repository.activateModelAndCreateEmployee({
      appId: 'default',
      userId: 'user:admin',
      candidateId: 'candidate:atlas',
      name: 'Atlas',
      title: 'General assistant',
      responsibilities: [],
    }),
  ).resolves.toEqual({
    agentId: 'agent:atlas',
    name: 'Atlas',
    version: 1,
    desiredStateRevision: 2,
    replayed: true,
  });
});
