import { describe, expect, it } from 'vitest';

import { jobPermissionCardText } from '@core/domain/job-permission-card-actions.js';

describe('jobPermissionCardText', () => {
  it('uses the settled retire text without the job id', () => {
    expect(
      jobPermissionCardText('job-123', {
        revision: 1,
        operation: 'retire',
        deliveryId: 'delivery-123',
        deliveryItemId: 'item-123',
        rows: [],
        representedNeeds: [],
        batchNeedIds: [],
        pageStart: 0,
        hiddenRowCount: 0,
        deliveryAttempt: 1,
        createdAt: '2026-08-27T00:00:00.000Z',
      }),
    ).toBe('All permission requests for this job are settled.');
  });
});
