import { describe, expect, it } from 'vitest';

import { usageEventIdForMessage } from '@core/adapters/llm/anthropic-claude-agent/runner/query-usage-event-id.js';

describe('Claude query loop usage event IDs', () => {
  it('uses stable provider IDs when present', () => {
    expect(
      usageEventIdForMessage({ request_id: 'req-1' }, 'session-1', 1, 'run-a'),
    ).toBe('req-1');
  });

  it('keeps fallback usage IDs unique across resumed query runs', () => {
    expect(usageEventIdForMessage({}, 'session-1', 1, 'run-a')).toBe(
      'session-1:run:run-a:result:1',
    );
    expect(usageEventIdForMessage({}, 'session-1', 1, 'run-b')).toBe(
      'session-1:run:run-b:result:1',
    );
  });
});
