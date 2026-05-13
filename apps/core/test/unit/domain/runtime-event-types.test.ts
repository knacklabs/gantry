import { describe, expect, it } from 'vitest';

import {
  isRuntimeEventType,
  parseRuntimeEventType,
  requireRuntimeEventType,
  RUNTIME_EVENT_TYPES,
} from '@core/domain/events/runtime-event-types.js';

describe('runtime event types', () => {
  it('defines the scheduled job heartbeat primitive', () => {
    expect(RUNTIME_EVENT_TYPES.JOB_HEARTBEAT).toBe('job.heartbeat');
  });

  it('accepts every canonical runtime event type', () => {
    for (const eventType of Object.values(RUNTIME_EVENT_TYPES)) {
      expect(isRuntimeEventType(eventType)).toBe(true);
      expect(parseRuntimeEventType(eventType)).toBe(eventType);
      expect(requireRuntimeEventType(eventType)).toBe(eventType);
    }
  });

  it('rejects unknown runtime event strings', () => {
    expect(isRuntimeEventType('runtime.unknown')).toBe(false);
    expect(parseRuntimeEventType('runtime.unknown')).toBeUndefined();
    expect(() => requireRuntimeEventType('runtime.unknown')).toThrow(
      'Runtime event type must be a known runtime event type.',
    );
  });
});
