import { describe, expect, it, vi } from 'vitest';

import { recoverCapabilityTemplateApprovalIntents } from '@core/jobs/capability-template-approval-intent-recovery.js';

describe('capability-template approval-intent recovery', () => {
  it('settles resumed and superseded targets and completes the intent', async () => {
    const settleApprovalIntentClaim = vi.fn(async () => 'completed' as const);
    const recoverTarget = vi
      .fn()
      .mockResolvedValueOnce('resumed')
      .mockResolvedValueOnce('superseded');
    const result = await recoverCapabilityTemplateApprovalIntents({
      repository: {
        claimDueApprovalIntents: vi.fn(async () => [
          {
            id: 'intent-1',
            appId: 'app-1',
            proposalId: 'proposal-1',
            capabilityId: 'acme.records.read',
            claimToken: 'claim-1',
            attemptCount: 1,
            targets: [
              { jobId: 'job-1', expectedSetupFingerprint: 'fingerprint-1' },
              { jobId: 'job-2', expectedSetupFingerprint: 'fingerprint-2' },
            ],
          },
        ]),
        settleApprovalIntentClaim,
      },
      claimerId: 'worker-1',
      recoverTarget,
      now: () => new Date('2026-08-14T00:00:00.000Z'),
    });

    expect(result).toEqual({ claimed: 1, completed: 1, pending: 0 });
    expect(settleApprovalIntentClaim).toHaveBeenCalledWith({
      intentId: 'intent-1',
      claimToken: 'claim-1',
      outcomes: [
        { jobId: 'job-1', status: 'resumed' },
        { jobId: 'job-2', status: 'superseded' },
      ],
      now: '2026-08-14T00:00:00.000Z',
      nextAttemptAt: '2026-08-14T00:00:05.000Z',
    });
  });

  it('leaves retry targets pending with exponential backoff', async () => {
    const settleApprovalIntentClaim = vi.fn(async () => 'pending' as const);
    const result = await recoverCapabilityTemplateApprovalIntents({
      repository: {
        claimDueApprovalIntents: vi.fn(async () => [
          {
            id: 'intent-2',
            appId: 'app-1',
            proposalId: 'proposal-2',
            capabilityId: 'acme.records.read',
            claimToken: 'claim-2',
            attemptCount: 4,
            targets: [
              { jobId: 'job-3', expectedSetupFingerprint: 'fingerprint-3' },
            ],
          },
        ]),
        settleApprovalIntentClaim,
      },
      claimerId: 'worker-1',
      recoverTarget: vi.fn(async () => 'retry'),
      now: () => new Date('2026-08-14T00:00:00.000Z'),
    });

    expect(result).toEqual({ claimed: 1, completed: 0, pending: 1 });
    expect(settleApprovalIntentClaim).toHaveBeenCalledWith({
      intentId: 'intent-2',
      claimToken: 'claim-2',
      outcomes: [],
      now: '2026-08-14T00:00:00.000Z',
      nextAttemptAt: '2026-08-14T00:00:40.000Z',
    });
  });
});
