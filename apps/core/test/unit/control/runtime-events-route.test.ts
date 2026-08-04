import { describe, expect, it } from 'vitest';

import type { AppId } from '../../../src/domain/app/app.js';
import { parseRuntimeEventFilter } from '../../../src/control/server/routes/runtime-events.js';

describe('runtime event route', () => {
  it('always builds an app-scoped durable replay filter', () => {
    expect(
      parseRuntimeEventFilter(
        new URL(
          'http://gantry/v1/runtime-events?afterEventId=42&jobId=job-1&eventType=job.run.completed,job.run.failed',
        ),
        'manipal-tender-copilot' as AppId,
      ),
    ).toEqual({
      appId: 'manipal-tender-copilot',
      afterEventId: 42,
      limit: 100,
      jobId: 'job-1',
      eventTypes: ['job.run.completed', 'job.run.failed'],
    });
  });

  it('rejects invalid cursors and event types', () => {
    expect(
      parseRuntimeEventFilter(
        new URL('http://gantry/v1/runtime-events?afterEventId=-1'),
        'app' as AppId,
      ),
    ).toMatch(/afterEventId/);
    expect(
      parseRuntimeEventFilter(
        new URL('http://gantry/v1/runtime-events?eventType=not.real'),
        'app' as AppId,
      ),
    ).toMatch(/unknown runtime event type/);
  });
});
