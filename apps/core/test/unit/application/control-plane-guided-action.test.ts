import { describe, expect, it } from 'vitest';

import { resolveControlPlaneGuidedAction } from '@core/application/guided-actions/guided-action-model.js';

describe('resolveControlPlaneGuidedAction', () => {
  it('resolves a blocked_job next-action to resume_job, preserving the label', () => {
    const ref = resolveControlPlaneGuidedAction({
      kind: 'blocked_job',
      label: 'Review blocked jobs.',
    });
    expect(ref.type).toBe('resume_job');
    expect(ref.label).toBe('Review blocked jobs.');
  });

  it('resolves a missing_access_approval next-action to grant_access', () => {
    const ref = resolveControlPlaneGuidedAction({
      kind: 'missing_access_approval',
      label: 'Approve pending access requests.',
    });
    expect(ref.type).toBe('grant_access');
    expect(ref.label).toBe('Approve pending access requests.');
  });

  it('resolves a none next-action to none', () => {
    const ref = resolveControlPlaneGuidedAction({
      kind: 'none',
      label: 'none',
    });
    expect(ref.type).toBe('none');
    expect(ref.label).toBe('none');
  });

  it('preserves params when the source carries a target id', () => {
    const ref = resolveControlPlaneGuidedAction({
      kind: 'blocked_job',
      label: 'Run `gantry jobs resume job_9` to resume the blocked job.',
      params: { jobId: 'job_9' },
    });
    expect(ref.type).toBe('resume_job');
    expect(ref.params).toEqual({ jobId: 'job_9' });
  });

  it('omits params when the source carries none', () => {
    const ref = resolveControlPlaneGuidedAction({
      kind: 'blocked_job',
      label: 'Review blocked jobs.',
    });
    expect(ref.params).toBeUndefined();
  });
});
