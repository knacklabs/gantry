import { expect, it } from 'vitest';

import { SessionTypingTracker } from '../../../../../packages/sdk/src/session-events.js';

it('ignores typing events without an ordered envelope', () => {
  const tracker = new SessionTypingTracker();
  const event = (payload: Record<string, unknown>, eventId: number) => ({
    eventId,
    eventType: 'session.typing',
    sessionId: 'session-1',
    threadId: 'thread-1',
    correlationId: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    payload,
  });

  expect(tracker.apply(event({ isTyping: true }, 1))).toBe(false);
  expect(tracker.isTyping('session-1', 'thread-1')).toBeUndefined();

  expect(
    tracker.apply(
      event(
        {
          isTyping: false,
          orderedEnvelope: { generation: 1, sequence: 1, kind: 'typing' },
        },
        2,
      ),
    ),
  ).toBe(true);
  expect(tracker.apply(event({ isTyping: true }, 3))).toBe(false);
  expect(tracker.isTyping('session-1', 'thread-1')).toBe(false);
});
