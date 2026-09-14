import { describe, expect, it, vi } from 'vitest';

import type { OnboardingSetupRepository } from '@core/application/onboarding/onboarding-setup-repository.interface.js';
import { OnboardingSetupService } from '@core/application/onboarding/onboarding-setup.service.js';

const request = {
  appId: 'app:test' as never,
  actorId: 'user:test',
  idempotencyKey: 'request-one',
  name: 'Atlas',
  title: 'General assistant',
  responsibilities: ['Answer questions.'],
  modelAlias: 'sonnet',
  agentHarness: 'auto' as const,
};

function repository(): OnboardingSetupRepository {
  return {
    findReplay: vi.fn(async () => null),
    createOrResume: vi.fn(async () => ({
      setupId: 'setup:one',
      agentId: 'agent:one',
      agentName: 'Atlas',
      desiredStateRevision: 1,
      replayed: false,
    })),
    updateProgress: vi.fn(async () => undefined),
  };
}

describe('OnboardingSetupService', () => {
  it('rejects unknown models before persistence', async () => {
    const store = repository();
    const validate = vi.fn(async () => ({ ok: true, message: 'ok' }));
    const service = new OnboardingSetupService(store, validate);

    await expect(
      service.createOrResume({ ...request, modelAlias: 'not-a-model' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(validate).not.toHaveBeenCalled();
    expect(store.createOrResume).not.toHaveBeenCalled();
  });

  it('requires a successful provider preflight before persistence', async () => {
    const store = repository();
    const service = new OnboardingSetupService(store, async () => ({
      ok: false,
      message: 'Credential is unavailable.',
    }));

    await expect(service.createOrResume(request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Credential is unavailable.',
    });
    expect(store.createOrResume).not.toHaveBeenCalled();
  });

  it('returns an idempotent replay without repeating provider preflight', async () => {
    const store = repository();
    vi.mocked(store.findReplay).mockResolvedValue({
      setupId: 'setup:one',
      agentId: 'agent:one',
      agentName: 'Atlas',
      desiredStateRevision: 1,
      replayed: true,
    });
    const validate = vi.fn(async () => ({ ok: false, message: 'offline' }));

    await expect(
      new OnboardingSetupService(store, validate).createOrResume(request),
    ).resolves.toMatchObject({ replayed: true });
    expect(validate).not.toHaveBeenCalled();
    expect(store.createOrResume).not.toHaveBeenCalled();
  });
});
