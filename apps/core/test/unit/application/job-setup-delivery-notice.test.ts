import { describe, expect, it } from 'vitest';

import {
  formatSetupDeliveryNotice,
  setupDeliveryNoticeFromEvents,
} from '@core/application/jobs/job-setup-delivery-notice.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type { JobEvent } from '@core/domain/types.js';

describe('setup delivery notice', () => {
  it('selects the latest event for the current setup fingerprint', () => {
    const events = [
      event('fp:current', 'exhausted', 4, 3),
      event('fp:stale', 'ambiguous', 2, 2),
      event('fp:current', 'delivered', 1, 1),
    ];

    expect(
      setupDeliveryNoticeFromEvents({
        events,
        setupFingerprint: 'fp:current',
      }),
    ).toEqual({
      outcome: 'exhausted',
      attempt: 4,
      text: formatSetupDeliveryNotice('exhausted'),
    });
  });

  it('ignores malformed, unrelated, and stale events', () => {
    const events = [
      { ...event('fp:current', 'delivered', 1, 3), payload: '{}' },
      { ...event('fp:current', 'delivered', 1, 2), event_type: 'job.failed' },
      event('fp:stale', 'delivered', 1, 1),
    ];

    expect(
      setupDeliveryNoticeFromEvents({
        events,
        setupFingerprint: 'fp:current',
      }),
    ).toBeNull();
  });
});

function event(
  fingerprint: string,
  outcome: string,
  attempt: number,
  id: number,
): JobEvent {
  return {
    id,
    job_id: 'job:test',
    run_id: null,
    event_type: RUNTIME_EVENT_TYPES.JOB_SETUP_CARD_DELIVERY,
    payload: JSON.stringify({
      prompt_id: 'prompt:test',
      generation: 1,
      job_id: 'job:test',
      setup_fingerprint: fingerprint,
      outcome,
      attempt,
      provider: 'telegram',
    }),
    created_at: `2026-08-13T10:00:0${id}.000Z`,
  };
}
