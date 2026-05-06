import { describe, expect, it, vi } from 'vitest';

import { CreateSandboxLeaseUseCase } from '@core/application/sandbox/create-sandbox-lease-use-case.js';

const lease = {
  id: 'sandbox-lease-1',
  appId: 'app-one',
  profileId: 'sandbox-profile-1',
  runId: 'run-1',
  permissionDecisionId: 'permission-decision-1',
  status: 'active',
  grantedAt: '2026-05-06T00:00:00.000Z',
  expiresAt: '2026-05-06T00:05:00.000Z',
};

describe('CreateSandboxLeaseUseCase', () => {
  it('fails closed when action evaluation denies sandbox leasing', async () => {
    const provider = { acquireLease: vi.fn(async () => lease) };
    const useCase = new CreateSandboxLeaseUseCase({
      provider: provider as never,
      sandboxes: { saveSandboxLease: vi.fn() } as never,
      toolEvaluator: {
        execute: vi.fn(async () => ({
          decision: { effect: 'deny', reason: 'No matching permission rule.' },
        })),
      } as never,
    });

    await expect(
      useCase.execute({
        profile: { id: 'sandbox-profile-1' } as never,
        run: { id: 'run-1' } as never,
        action: { appId: 'app-one' as never, toolName: 'Bash' },
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(provider.acquireLease).not.toHaveBeenCalled();
  });

  it('leases only after an allow or sandbox-required decision', async () => {
    const sandboxes = { saveSandboxLease: vi.fn() };
    const provider = { acquireLease: vi.fn(async () => lease) };
    const useCase = new CreateSandboxLeaseUseCase({
      provider: provider as never,
      sandboxes: sandboxes as never,
      toolEvaluator: {
        execute: vi.fn(async () => ({
          decision: { effect: 'require_sandbox', reason: 'Sandbox required.' },
        })),
      } as never,
    });

    await expect(
      useCase.execute({
        profile: { id: 'sandbox-profile-1' } as never,
        run: { id: 'run-1' } as never,
        action: { appId: 'app-one' as never, toolName: 'Write' },
      }),
    ).resolves.toEqual({ lease });
    expect(sandboxes.saveSandboxLease).toHaveBeenCalledWith(lease);
  });
});
